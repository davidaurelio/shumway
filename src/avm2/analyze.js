var Bytecode = (function () {
  function Bytecode(code) {
    var op = code.readU8();
    this.op = op;
    var i, n;

    switch (op) {
    case OP_lookupswitch:
      /* offsets[0] is the default offset. */
      this.offsets = [code.readS24()];
      var n = code.readU30() + 1;
      for (i = 0; i < n; i++) {
        this.offsets.push(code.readS24());
      }
      break;
    default:
      var opdesc = opcodeTable[op];
      if (!opdesc) {
        unexpected();
      }

      for (i = 0, n = opdesc.operands.length; i < n; i++) {
        var operand = opdesc.operands[i];

        switch (operand.size) {
        case "u08":
          this[operand.name] = code.readU8();
          break;
        case "s16":
          this[operand.name] = code.readU30Unsafe();
          break;
        case "s24":
          this[operand.name] = code.readS24();
          break;
        case "u30":
          this[operand.name] = code.readU30();
          break;
        case "u32":
          this[operand.name] = code.readU32();
          break;
        default:
          unexpected();
        }
      }
    }
  }

  var Bp = Bytecode.prototype;

  Bp.makeBlockHead = function makeBlockHead() {
    if (this.succs) {
      return;
    }

    this.succs = [];
    this.preds = [];
  };

  Bp.makeLoopHead = function makeLoopHead(succ) {
    if (this.loopSucc) {
      return;
    }

    assert(this.succs);

    this.loopSucc = succ;
  };

  Bp.addSucc = function addSucc(succ) {
    assert(this.succs);
    this.succs.push(succ);
  };

  Bp.addPred = function addPred(pred) {
    assert(this.succs);
    this.preds.push(pred);
  };

  Bp.blockType = function blockType() {
    assert(!!this.succs, "blockType only valid on block headers");

    if (this.loopSucc) {
      return BLOCK_LOOP;
    }

    return BLOCK_SIMPLE;
  };

  Bp.toString = function toString() {
    var opdesc = opcodeTable[this.op];
    var str = opdesc.name.padRight(' ', 20);
    var i, j;

    if (this.op === OP_lookupswitch) {
      str += "defaultOffset:" + this.offsets[0];
      for (i = 1, j = this.offsets.length; i < j; i++) {
        str += ", offset:" + this.offsets[i];
      }
    } else {
      for (i = 0, j = opdesc.operands.length; i < j; i++) {
        var operand = opdesc.operands[i];
        str += operand.name + ":" + this[operand.name];
        if (i < j - 1) {
          str += ", ";
        }
      }
    }

    return str;
  };

  return Bytecode;
})();

var Analysis = (function () {

  function intersect(doms, b1, b2) {
    var finger1 = b1;
    var finger2 = b2;
    while (finger1 !== finger2) {
      while (finger1 < finger2) {
        finger1 = doms[finger1];
      }
      while (finger2 < finger1) {
        finger2 = doms[finger2];
      }
    }
    return finger1;
  }

  function dfs(bytecodes, pre, post) {
    /* Block 0 is always the root block. */
    var dfs = [0];
    var visited = {};
    var node;

    while (dfs.length) {
      node = dfs.peek();
      if (visited[node]) {
        dfs.pop();
        if (post) {
          post(node);
        }
      } else if (pre) {
        pre(node);
      }

      var succs = bytecodes[node].succs;
      for (var i = 0, j = succs.length; i < j; i++) {
        var s = succs[i];
        if (!visited[s]) {
          dfs.push(s);
        }
      }

      visited[node] = true;
    }
  }

  function analyzeBasicBlocks(bytecodes) {
    var code;
    var pc, end;

    function doubleLink(pred, succ) {
      bytecodes[pred].addSucc(succ);
      bytecodes[succ].addPred(pred);
    }

    assert(bytecodes);

    bytecodes[0].makeBlockHead();
    for (pc = 0, end = bytecodes.length; pc < end; pc++) {
      code = bytecodes[pc];
      switch (code.op) {
      case OP_lookupswitch:
        code.offsets.forEach(function (offset) {
          bytecodes[pc + offset].makeBlockHead();
        });
        break;

      case OP_jump:
        bytecodes[pc + code.offset].makeBlockHead();
        break;

      case OP_iflt:
      case OP_ifnlt:
      case OP_ifle:
      case OP_ifnlt:
      case OP_ifnle:
      case OP_ifgt:
      case OP_ifge:
      case OP_ifngt:
      case OP_ifeq:
      case OP_ifne:
      case OP_ifstricteq:
      case OP_ifstrictne:
      case OP_iftrue:
      case OP_iffalse:
        bytecodes[pc + code.offset].makeBlockHead();
        bytecodes[++pc].makeBlockHead();
        break;

      default:;
      }
    }

    var start = 0;
    for (pc = 1, end = bytecodes.length; pc < end; pc++) {
      if (!bytecodes[pc].succs) {
        continue;
      }

      assert(bytecodes[start].succs);
      /* Cache how long the basic block is to help iteration. */
      bytecodes[start].blockLength = pc - start;

      var nextBlockCode = bytecodes[pc];

      code = bytecodes[pc - 1];
      switch (code.op) {
      case OP_lookupswitch:
        code.offsets.forEach(function (offset) {
          doubleLink(start, pc - 1 + offset);
        });
        break;

      case OP_jump:
        doubleLink(start, pc - 1 + code.offset);
        break;

      case OP_iflt:
      case OP_ifnlt:
      case OP_ifle:
      case OP_ifnlt:
      case OP_ifnle:
      case OP_ifgt:
      case OP_ifge:
      case OP_ifngt:
      case OP_ifeq:
      case OP_ifne:
      case OP_ifstricteq:
      case OP_ifstrictne:
      case OP_iftrue:
      case OP_iffalse:
        doubleLink(start, pc - 1 + code.offset);
        doubleLink(start, pc);
        break;

      default:
        doubleLink(start, pc);
      }

      start = pc;
    }
  }

  /*
   * Calculate the dominance relation.
   *
   * Algorithm is from [1].
   *
   * [1] Cooper et al. "A Simple, Fast Dominance Algorithm"
   */
  function analyzeDominance(bytecodes) {
    /* For this algorithm we id blocks by their index in postorder. */
    var blocks = [];
    dfs(bytecodes, null, blocks.push.bind(blocks));
    var n = blocks.length;
    var sortedIndices = {};
    for (var i = 0; i < n; i++) {
      sortedIndices[blocks[i]] = i;
    }

    /* The indices in doms is the block's index in sortedIndices, not blocks! */
    var doms = new Array(n);
    doms[n-1] = n-1;
    var changed = true;

    while (changed) {
      changed = false;

      /* Iterate all blocks but the starting block in reverse postorder. */
      for (var b = n - 2; b >= 0; b--) {
        var preds = bytecodes[blocks[b]].preds;
        var newIdom = sortedIndices[preds[0]];

        for (var i = 1, j = preds.length; i < j; i++) {
          var p = sortedIndices[preds[i]];

          if (doms[p]) {
            newIdom = intersect(doms, p, newIdom);
          }
        }

        if (doms[b] !== newIdom) {
          doms[b] = newIdom;
          changed = true;
        }
      }
    }

    for (var i = 0; i < n; i++) {
      bytecodes[blocks[i]].dominator = blocks[doms[i]];
    }
  }

  /*
   * Find the dominator set from immediate dominators.
   */
  function dom(bytecodes, offset) {
    var code = bytecodes[offset];

    assert(code.succs);
    assert(code.dominator !== undefined);

    var dom = [offset];
    do {
      var idom = code.dominator;
      dom.push(idom);
      code = bytecodes[idom];
    } while (idom !== code.dominator);

    return dom;
  }

  /*
   * Find loops.
   *
   * Adobe's asc, like SpiderMonkey, emit loops where the loop header is at
   * the "bottom", i.e. higher pc:
   *
   * i        jump to i+off
   * i+1      label
   * i+2      ...
   * i+3      ...
   * .        ...
   * .        ...
   * i+off    <test condition>
   * i+off+1  branch to i+1
   *
   * The only exception is a do..while, which has a jump to i+2.
   *
   * So we don't really need to find SCCs in general, just nodes who branch
   * back to their immediate dominators. Those nodes' immediate dominators are
   * loop headers.
   */
  function findLoops(bytecodes) {
    dfs(bytecodes, null,
        function (b) {
          var node = bytecodes[b];

          if (node.succs.indexOf(node.dominator) >= 0) {
            bytecodes[node.dominator].makeLoopHead(b);
          }
        });
  }

  function Analysis(codeStream) {
    /*
     * Normalize the code stream. The other analyses are run by the user
     * on demand.
     */
    this.analyzeBytecode(new AbcStream(codeStream));
  }

  var Ap = Analysis.prototype;

  Ap.analyzeBytecode = function analyzeBytecode(codeStream) {
    /* This array is sparse, indexed by offset. */
    var bytecodesOffset = [];
    /* This array is dense. */
    var bytecodes = [];
    var code;

    var normalizedOffset = 0;
    while (codeStream.remaining() > 0) {
      var pos = codeStream.position;
      code = new Bytecode(codeStream);

      /* Get absolute offsets for normalization to new indices below. */
      switch (code.op) {
      case OP_lookupswitch:
        code.offsets.map(function (offset) {
          return codeStream.position + offset;
        });
        break;

      case OP_jump:
      case OP_iflt:
      case OP_ifnlt:
      case OP_ifle:
      case OP_ifnlt:
      case OP_ifnle:
      case OP_ifgt:
      case OP_ifge:
      case OP_ifngt:
      case OP_ifeq:
      case OP_ifne:
      case OP_ifstricteq:
      case OP_ifstrictne:
      case OP_iftrue:
      case OP_iffalse:
        code.offset = codeStream.position + code.offset;
        break;

      default:;
      }

      bytecodesOffset[pos] = normalizedOffset++;
      bytecodes.push(code);
    }

    for (var pc = 0, end = bytecodes.length; pc < end; pc++) {
      code = bytecodes[pc];
      switch (code.op) {
      case OP_lookupswitch:
        code.offsets.map(function (offset) {
          return bytecodesOffset[offset] - pc;
        });
        break;

      case OP_jump:
      case OP_iflt:
      case OP_ifnlt:
      case OP_ifle:
      case OP_ifnlt:
      case OP_ifnle:
      case OP_ifgt:
      case OP_ifge:
      case OP_ifngt:
      case OP_ifeq:
      case OP_ifne:
      case OP_ifstricteq:
      case OP_ifstrictne:
      case OP_iftrue:
      case OP_iffalse:
        code.offset = bytecodesOffset[code.offset] - pc;
        break;

      default:;
      }
    }

    this.bytecodes = bytecodes;
  };

  Ap.analyzeControlFlow = function analyzeControlFlow() {
    assert(this.bytecodes);

    var bytecodes = this.bytecodes;
    analyzeBasicBlocks(bytecodes);
    analyzeDominance(bytecodes);
    findLoops(bytecodes);
  }

  /*
   * Prints a normalized bytecode along with metainfo.
   *
   * Basic blocks are identified by the position of the first bytecode in the
   * block. The format for each blocks, b, is:
   *   idom(b) >> b -> succ(b) 1, ...
   *
   * Loops are identified by:
   *   loop [loop body block 0, loop body block 1, ...]
   */

  Ap.trace = function(writer) {
    writer.enter("analysis {");

    var ranControlFlow = !!this.bytecodes[0].succs;

    for (var pc = 0, end = this.bytecodes.length; pc < end; pc++) {
      var code = this.bytecodes[pc];

      if (ranControlFlow && code.succs) {
        if (pc > 0) {
          writer.leave("}");
        }

        writer.enter("block " + code.dominator + " >> " + pc +
               (code.succs.length > 0 ? " -> " + code.succs : "") + " {");

        if (code.loopSucc) {
          writer.writeLn("loop successor " + code.loopSucc);
          writer.writeLn("");
        }
      }

      writer.writeLn(("" + pc).padRight(' ', 5) + code);

      if (ranControlFlow && pc === end - 1) {
        writer.leave("}");
      }
    }

    writer.leave("}");
  };

  return Analysis;

})();