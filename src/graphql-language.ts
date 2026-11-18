type Value = null | boolean | number | string | { variable: string } | { list: Value[] } | { object: [string, Value][] };
export type Field = { name: string; alias: string; args: [string, Value][]; directives: Directive[]; children: Selection[]; line: number; column: number };
type Directive = { name: string; args: [string, Value][] };
export type Selection = Field | { spread: string; on: boolean; children: Selection[]; directives: Directive[] };
export type Operation = { type: string; name?: string; defaults: Map<string, Value>; children: Selection[] };
type Token = { text: string; kind: string; line: number; column: number };

function tokenize(source: string) {
  const pattern = /(?:[\s,\uFEFF]+|#[^\r\n]*|\.\.\.|[_A-Za-z][_0-9A-Za-z]*|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|"(?:\\[^\r\n]|[^"\\\r\n])*"|[!$():=@\[\]{|}&])/y;
  const tokens: Token[] = [];
  let line = 1, column = 1;
  while (pattern.lastIndex < source.length) {
    const offset = pattern.lastIndex, match = pattern.exec(source);
    if (!match) throw Error(`Unexpected character at ${line}:${column}: ${source[offset]}`);
    const text = match[0], first = text[0];
    if (!/[\s,#\uFEFF]/.test(first)) tokens.push({ text, kind: first === '"' ? 'string' : /[-\d]/.test(first) ? 'number' : /[_A-Za-z]/.test(first) ? 'name' : 'symbol', line, column });
    const rows = text.split(/\r\n|\r|\n/);
    if (rows.length > 1) { line += rows.length - 1; column = rows.at(-1)!.length + 1; } else column += text.length;
    if (tokens.length > 20000) throw Error('Document too large');
  }
  return tokens;
}

export function parse(source: string) {
  const tokens = tokenize(source);
  let pos = 0, depth = 0;
  const check = (s: string) => tokens[pos]?.text === s;
  const eat = (s: string) => { if (!check(s)) return false; pos++; return true; };
  const expect = (s: string) => { if (!eat(s)) throw Error(`Expected ${s}, found ${tokens[pos]?.text ?? 'end of document'}`); };
  function name() { const t = tokens[pos++]; if (t?.kind !== 'name') throw Error('Expected a name'); return t.text; }
  function bounded<T>(parse: () => T): T {
    if (++depth > 60) throw Error('Document nested too deeply');
    try { return parse(); } finally { depth--; }
  }
  function value(): Value { return bounded(() => {
    if (eat('$')) return { variable: name() };
    if (eat('[')) { const list: Value[] = []; while (!eat(']')) list.push(value()); return { list }; }
    if (eat('{')) {
      const object: [string, Value][] = [];
      while (!eat('}')) { const key = name(); expect(':'); object.push([key, value()]); }
      return { object };
    }
    const token = tokens[pos++];
    if (token?.kind === 'string') return JSON.parse(token.text);
    if (token?.kind === 'number') return Number(token.text);
    if (token?.kind !== 'name') throw Error('Expected a value');
    if (token.text === 'true') return true;
    if (token.text === 'false') return false;
    if (token.text === 'null') return null;
    return token.text;
  }); }
  function args() {
    const values: [string, Value][] = [];
    if (eat('(')) while (!eat(')')) { const k = name(); expect(':'); values.push([k, value()]); }
    return values;
  }
  function directives(): Directive[] {
    const d: Directive[] = [];
    while (eat('@')) d.push({ name: name(), args: args() });
    return d;
  }
  function selection(): Selection[] { return bounded(() => {
    expect('{'); const picks: Selection[] = [];
    while (!eat('}')) {
      if (eat('...')) {
        const on = eat('on');
        const spread = tokens[pos]?.kind === 'name' ? name() : '';
        const d = directives();
        picks.push({ spread, on: on || !spread, children: check('{') ? selection() : [], directives: d });
      } else {
        const token = tokens[pos];
        const alias = name(), actual = eat(':') ? name() : alias;
        picks.push({ name: actual, alias, args: args(), directives: directives(), children: check('{') ? selection() : [], line: token.line, column: token.column });
      }
    }
    return picks;
  }); }
  function type() { bounded(() => { if (eat('[')) { type(); expect(']'); } else name(); eat('!'); }); }
  const operations: Operation[] = [], fragments = new Map<string, { type: string; children: Selection[] }>();
  while (pos < tokens.length) {
    if (eat('fragment')) {
      const id = name(); expect('on'); const type = name(); directives();
      if (fragments.has(id)) throw Error(`Duplicate fragment ${id}`);
      fragments.set(id, { type, children: selection() });
      continue;
    }
    const mode = check('{') ? 'query' : name();
    if (!['query', 'mutation', 'subscription'].includes(mode)) throw Error(`Unknown operation ${mode}`);
    const id = tokens[pos]?.kind === 'name' ? name() : undefined;
    const defaults = new Map<string, Value>();
    if (eat('(')) while (!eat(')')) {
      expect('$'); const variable = name(); expect(':'); type();
      if (eat('=')) defaults.set(variable, value());
      directives();
    }
    directives(); operations.push({ type: mode, name: id, defaults, children: selection() });
  }
  return { operations, fragments };
}
export function input(value: Value, vars: Record<string, unknown>): any {
  if (value === null || typeof value !== 'object') return value;
  if ('variable' in value) return Object.hasOwn(vars, value.variable) ? vars[value.variable] : undefined;
  if ('list' in value) return value.list.map(v => input(v, vars));
  return Object.fromEntries(value.object.map(([k, v]) => [k, input(v, vars)]));
}
export function argumentsOf(args: [string, Value][], vars: Record<string, unknown>) { return Object.fromEntries(args.map(([k, v]) => [k, input(v, vars)])); }
