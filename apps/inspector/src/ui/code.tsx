/** A light JavaScript/JSON tokenizer: enough colour to read code at a glance. */
const keyword =
  /^(const|let|var|await|return|async|new|throw|true|false|null|undefined|for|of|if|else|function)$/;

function tokens(line: string): { text: string; kind: string }[] {
  const pattern =
    /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\sA-Za-z_$\d"'`]+)/g;
  const out: { text: string; kind: string }[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(line))) {
    const rest = line.slice(pattern.lastIndex);
    let kind = 'p';

    if (match[1]) kind = 'com';
    else if (match[2]) kind = /^\s*:/.test(rest) ? 'key' : 'str';
    else if (match[3]) kind = 'num';
    else if (match[4])
      kind = keyword.test(match[4])
        ? 'kw'
        : /^\s*:/.test(rest)
          ? 'key'
          : /^\s*\(/.test(rest)
            ? 'fn'
            : 'id';
    else if (match[5]) kind = '';

    const last = out.at(-1);

    if (last && (kind === '' || last.kind === kind)) last.text += match[0];
    else out.push({ text: match[0], kind: kind || 'p' });
  }

  return out;
}

export function Code(props: {
  readonly source: string;
  readonly numbered?: boolean;
}) {
  return (
    <div className={`code-view${props.numbered ? ' numbered' : ''}`}>
      {props.source.split('\n').map((line, index) => (
        <div key={index} className="code-view-line">
          {props.numbered && <span className="n">{index + 1}</span>}
          <span className="src">
            {tokens(line).map((token, at) => (
              <span key={at} className={`tok-${token.kind}`}>
                {token.text}
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}
