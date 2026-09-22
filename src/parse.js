// The pattern language. Every operator is regex's; only the atoms differ.
//
//   {a person's name}   a span Jev judges to be that thing   (regex: [a-z]+)
//   !{a proper noun}    one token Jev judges it is not       (regex: [^a-z])
//   "thank you"         a literal token sequence             (regex: thank you)
//   bare                an unquoted literal token
//   /\d{4}/             a real regex, over one token span    (escape hatch)
//   .                   any one token                        (regex: .)
//   ^ $                 start and end of the chunk
//   ? * + {n} {n,m}     quantifiers, greedy; suffix ? for lazy
//   |                   alternation
//   ( ) (?: ) (?<n> )   groups, non-capturing, named capture
//   (?= ) (?! )         lookahead
//
// Whitespace between atoms is insignificant, so a pattern can be spaced out for
// reading. Backslash escapes any metacharacter.

import { tokenize } from "./tokens.js";

const META = new Set([..."{}()|?*+.^$!\"/\\"]);

/** A literal is matched token by token, so it is tokenized the same way text is. */
const literalNode = (text) => ({ t: "lit", text, tokens: tokenize(text).map((token) => token.text) });

class Parser {
  constructor(source) {
    this.source = source;
    this.i = 0;
  }

  fail(message) {
    throw new SyntaxError(`jevex pattern: ${message} at position ${this.i} of ${JSON.stringify(this.source)}`);
  }

  eof() {
    return this.i >= this.source.length;
  }

  peek(ahead = 0) {
    return this.source[this.i + ahead];
  }

  skipSpace() {
    while (!this.eof() && /\s/.test(this.peek())) this.i++;
  }

  parse() {
    const node = this.alternation();
    this.skipSpace();
    if (!this.eof()) this.fail(`unexpected ${JSON.stringify(this.peek())}`);
    return node;
  }

  alternation() {
    const options = [this.sequence()];
    this.skipSpace();
    while (this.peek() === "|") {
      this.i++;
      options.push(this.sequence());
      this.skipSpace();
    }
    return options.length === 1 ? options[0] : { t: "alt", options };
  }

  sequence() {
    const items = [];
    for (;;) {
      this.skipSpace();
      if (this.eof() || this.peek() === "|" || this.peek() === ")") break;
      items.push(this.repeat());
    }
    return items.length === 1 ? items[0] : { t: "seq", items };
  }

  repeat() {
    const node = this.atom();
    const quantifier = this.quantifier();
    if (!quantifier) return node;
    if (quantifier.max !== Infinity && quantifier.max < quantifier.min) {
      this.fail(`quantifier {${quantifier.min},${quantifier.max}} counts down`);
    }
    return { t: "rep", node, ...quantifier };
  }

  /** A quantifier binds tightly, so no whitespace is skipped before it. */
  quantifier() {
    const quantifierChar = this.peek();
    let min;
    let max;
    if (quantifierChar === "?") {
      [min, max] = [0, 1];
      this.i++;
    } else if (quantifierChar === "*") {
      [min, max] = [0, Infinity];
      this.i++;
    } else if (quantifierChar === "+") {
      [min, max] = [1, Infinity];
      this.i++;
    } else if (quantifierChar === "{") {
      const counted = /^\{(\d+)(,(\d*)?)?\}/.exec(this.source.slice(this.i));
      if (!counted) return null; // a `{` that is not a count starts a new atom
      min = Number(counted[1]);
      max = counted[2] === undefined ? min : counted[3] ? Number(counted[3]) : Infinity;
      this.i += counted[0].length;
    } else {
      return null;
    }
    const lazy = this.peek() === "?";
    if (lazy) this.i++;
    return { min, max, lazy };
  }

  /**
   * Read until `close`, honouring backslash escapes.
   *
   * `keepEscapes` leaves the backslash in place for everything but the closing
   * delimiter, which is what a `/regex/` body needs: `\d` has to reach RegExp
   * as `\d`, while `\/` still has to mean a literal slash.
   */
  readUntil(close, what, { keepEscapes = false } = {}) {
    let out = "";
    while (!this.eof() && this.peek() !== close) {
      if (this.peek() === "\\") {
        this.i++;
        if (this.eof()) this.fail(`unfinished escape in ${what}`);
        if (keepEscapes && this.peek() !== close) out += "\\";
      }
      out += this.peek();
      this.i++;
    }
    if (this.eof()) this.fail(`unclosed ${what}`);
    this.i++;
    return out;
  }

  atom() {
    const leadingChar = this.peek();

    if (leadingChar === "(") return this.group();

    if (leadingChar === "{") {
      this.i++;
      const description = this.readUntil("}", "{description}").trim();
      if (!description) this.fail("empty {description}");
      return { t: "sem", description, negated: false };
    }

    if (leadingChar === "!" && this.peek(1) === "{") {
      this.i += 2;
      const description = this.readUntil("}", "!{description}").trim();
      if (!description) this.fail("empty !{description}");
      return { t: "sem", description, negated: true };
    }

    if (leadingChar === '"') {
      this.i++;
      return literalNode(this.readUntil('"', "quoted literal"));
    }

    if (leadingChar === "/") {
      this.i++;
      const body = this.readUntil("/", "/regex/", { keepEscapes: true });
      let flags = "";
      while (!this.eof() && /[a-z]/.test(this.peek())) flags += this.source[this.i++];
      try {
        return { t: "re", regex: new RegExp(`^(?:${body})$`, flags.replace(/[gy]/g, "")) };
      } catch (error) {
        this.fail(`invalid /regex/: ${error.message}`);
      }
    }

    if (leadingChar === ".") {
      this.i++;
      return { t: "any" };
    }

    if (leadingChar === "^") {
      this.i++;
      return { t: "start" };
    }

    if (leadingChar === "$") {
      this.i++;
      return { t: "end" };
    }

    const literal = this.readBareLiteral();
    if (!literal) this.fail(`unexpected ${JSON.stringify(leadingChar)}`);
    return literalNode(literal);
  }

  /** An unquoted literal: runs until whitespace or an unescaped metacharacter. */
  readBareLiteral() {
    let text = "";
    while (!this.eof() && !/\s/.test(this.peek()) && (this.peek() === "\\" || !META.has(this.peek()))) {
      if (this.peek() === "\\") {
        this.i++;
        if (this.eof()) this.fail("unfinished escape");
      }
      text += this.source[this.i++];
    }
    return text;
  }

  group() {
    this.i++; // (
    let name = null;
    let capture = true;
    if (this.peek() === "?") {
      const next = this.peek(1);
      if (next === ":") {
        this.i += 2;
        capture = false;
      } else if (next === "=" || next === "!") {
        this.i += 2;
        const node = this.alternation();
        this.skipSpace();
        if (this.peek() !== ")") this.fail("unclosed lookahead");
        this.i++;
        return { t: "look", node, negative: next === "!" };
      } else if (next === "<") {
        this.i += 2;
        name = this.readUntil(">", "group name");
        if (!name) this.fail("empty group name");
      } else {
        this.fail(`unsupported group prefix (?${next ?? ""}`);
      }
    }
    const node = this.alternation();
    this.skipSpace();
    if (this.peek() !== ")") this.fail("unclosed group");
    this.i++;
    return { t: "group", name, capture, node };
  }
}

/** Compile a pattern string into an AST. */
export function parse(source) {
  if (typeof source !== "string" || !source.trim()) {
    throw new SyntaxError("jevex pattern: expected a non-empty pattern string");
  }
  return new Parser(source).parse();
}

/** Every distinct semantic description the pattern can ask about. */
export function descriptions(node, into = new Set()) {
  walk(node, (child) => {
    if (child.t === "sem") into.add(child.description);
  });
  return [...into];
}

function walk(node, visit) {
  visit(node);
  if (node.t === "alt") node.options.forEach((option) => walk(option, visit));
  else if (node.t === "seq") node.items.forEach((item) => walk(item, visit));
  else if (node.t === "rep" || node.t === "group" || node.t === "look") walk(node.node, visit);
}

/**
 * The semantic atoms every match must contain, used to skip chunks before
 * paying for a full judgment table. This is the same trick a regex engine uses
 * when it prefilters on a pattern's required literal.
 */
export function requiredDescriptions(node) {
  switch (node.t) {
    case "sem":
      return node.negated ? [] : [node.description];
    case "seq":
      return node.items.flatMap(requiredDescriptions);
    case "group":
      return requiredDescriptions(node.node);
    case "rep":
      return node.min > 0 ? requiredDescriptions(node.node) : [];
    case "alt": {
      const perOption = node.options.map((option) => new Set(requiredDescriptions(option)));
      if (!perOption.length) return [];
      return [...perOption[0]].filter((description) => perOption.every((set) => set.has(description)));
    }
    default:
      return [];
  }
}
