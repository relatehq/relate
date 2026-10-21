/**
 * The playground's code editor: CodeMirror with JavaScript, SQL highlighting
 * inside `compute.*.sql` templates, discovery-driven completion and hover,
 * problems as underlines with one-click fixes, and the result type of each
 * computed field once a run has reported it.
 *
 * The editor owns its document; React owns everything it shows about it.
 * Problems, discovery and result types arrive as props and are pushed into
 * the view, so the screen decides what is current.
 */
import { useEffect, useRef } from 'react';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  snippetCompletion,
} from '@codemirror/autocomplete';
import type {
  Completion,
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { lintGutter, lintKeymap, setDiagnostics } from '@codemirror/lint';
import type { Diagnostic } from '@codemirror/lint';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import type { Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  hoverTooltip,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { PlaygroundDiscovery } from '../protocol.js';
import type { Problem } from './checks.js';
import { describeSql, suggest } from './completion.js';
import { entryOf, graphCalls, sqlTemplates } from './source.js';

/** A computed field's type as a run reported it in `meta.computed`. */
export interface FieldType {
  readonly type: string;
  readonly nullable?: boolean;
}

const highlight = HighlightStyle.define([
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.moduleKeyword,
      tags.definitionKeyword,
      tags.operatorKeyword,
    ],
    color: 'var(--pg-syntax-keyword)',
  },
  {
    tag: [tags.string, tags.special(tags.string)],
    color: 'var(--pg-syntax-string)',
  },
  {
    tag: [tags.number, tags.bool, tags.null],
    color: 'var(--pg-syntax-number)',
  },
  {
    tag: tags.comment,
    color: 'var(--t-font-color-tertiary)',
    fontStyle: 'italic',
  },
  {
    tag: [tags.propertyName, tags.definition(tags.propertyName)],
    color: 'var(--pg-syntax-property)',
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: 'var(--pg-syntax-function)',
  },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px' },
  '.cm-scroller': {
    fontFamily: 'var(--t-code-font-family)',
    lineHeight: '1.6',
  },
  '.cm-content': { padding: '10px 0' },
  '.cm-gutters': {
    background: 'var(--t-background-primary)',
    color: 'var(--t-font-color-extra-light)',
    border: 'none',
  },
  '.cm-activeLine': { background: 'var(--t-background-transparent-light)' },
  '.cm-activeLineGutter': {
    background: 'transparent',
    color: 'var(--t-font-color-secondary)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--t-font-color-primary)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    background: 'var(--pg-selection) !important',
  },
  '.cm-tooltip': {
    background: 'var(--t-background-primary)',
    border: '1px solid var(--t-border-color-medium)',
    borderRadius: '6px',
    boxShadow: 'var(--t-box-shadow-strong)',
    color: 'var(--t-font-color-primary)',
    fontFamily: 'var(--t-font-family)',
    fontSize: '12px',
  },
  '.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--t-code-font-family)',
    fontSize: '12px',
    maxHeight: '16em',
  },
  '.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px !important' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    background: 'var(--t-color-blue4)',
    color: 'var(--t-font-color-primary)',
  },
  '.cm-completionDetail': {
    color: 'var(--t-font-color-tertiary)',
    fontStyle: 'normal',
    marginLeft: '1.2em',
  },
  '.cm-completionInfo': {
    padding: '8px 10px',
    maxWidth: '320px',
    whiteSpace: 'pre-line',
    lineHeight: '1.45',
  },
  '.cm-diagnostic': {
    padding: '6px 10px',
    fontFamily: 'var(--t-font-family)',
    borderLeftWidth: '3px',
  },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--t-color-red9)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--t-color-amber9)' },
  '.cm-diagnosticAction': {
    background: 'var(--t-color-blue9)',
    color: 'white',
    borderRadius: '4px',
    padding: '2px 8px',
    marginLeft: '8px',
    font: '500 11.5px var(--t-font-family)',
  },
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--t-color-red9)',
    textUnderlineOffset: '3px',
    textDecorationSkipInk: 'none',
  },
  '.cm-lintRange-warning': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--t-color-amber9)',
    textUnderlineOffset: '3px',
    textDecorationSkipInk: 'none',
  },
});

/** SQL inside templates: a tinted block with keywords, `$params`, `self` and strings marked. */
const sqlToken =
  /\b(SELECT|FROM|AS|WHERE|AND|OR|NOT|IS|NULL|DISTINCT|TRUE|FALSE|COUNT|SUM|AVG|MIN|MAX|COALESCE)\b|\$\w+|\bself\b|'(?:[^']|'')*'/gi;
const sqlMarks = {
  block: Decoration.mark({ class: 'pg-sql' }),
  keyword: Decoration.mark({ class: 'pg-sql-keyword' }),
  function: Decoration.mark({ class: 'pg-sql-function' }),
  parameter: Decoration.mark({ class: 'pg-sql-parameter' }),
  self: Decoration.mark({ class: 'pg-sql-self' }),
  string: Decoration.mark({ class: 'pg-sql-string' }),
};

function sqlDecorations(view: EditorView): DecorationSet {
  const text = view.state.doc.toString();
  const ranges: Range<Decoration>[] = [];

  for (const template of sqlTemplates(text)) {
    if (template.contentTo > template.contentFrom)
      ranges.push(
        sqlMarks.block.range(template.contentFrom, template.contentTo),
      );

    const sql = text.slice(template.contentFrom, template.contentTo);

    for (const match of sql.matchAll(sqlToken)) {
      const from = template.contentFrom + match.index;
      const token = match[0];
      const mark = token.startsWith('$')
        ? sqlMarks.parameter
        : token.startsWith("'")
          ? sqlMarks.string
          : token.toLowerCase() === 'self'
            ? sqlMarks.self
            : /^(count|sum|avg|min|max|coalesce)$/i.test(token)
              ? sqlMarks.function
              : sqlMarks.keyword;

      ranges.push(mark.range(from, from + token.length));
    }
  }

  return Decoration.set(ranges, true);
}

const sqlHighlighting = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = sqlDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = sqlDecorations(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

class TypeHint extends WidgetType {
  constructor(readonly field: FieldType) {
    super();
  }

  override eq(other: TypeHint) {
    return (
      other.field.type === this.field.type &&
      other.field.nullable === this.field.nullable
    );
  }

  override toDOM() {
    const hint = document.createElement('span');

    hint.className = 'pg-type-hint';
    hint.textContent = `${this.field.type}${this.field.nullable ? ' | null' : ''}`;
    hint.title = 'Result type reported by the last run (meta.computed)';

    return hint;
  }
}

const setFieldTypes = StateEffect.define<Readonly<Record<string, FieldType>>>();

/** Type hints after each `compute` alias key the last run reported a type for. */
const fieldTypes = StateField.define<{
  readonly types: Readonly<Record<string, FieldType>>;
  readonly decorations: DecorationSet;
}>({
  create: () => ({ types: {}, decorations: Decoration.none }),
  update(value, transaction) {
    let types = value.types;

    for (const effect of transaction.effects)
      if (effect.is(setFieldTypes)) types = effect.value;

    if (types === value.types && !transaction.docChanged) return value;

    const ranges: Range<Decoration>[] = [];

    for (const call of graphCalls(transaction.state.doc.toString())) {
      const compute = entryOf(call.options, 'compute')?.value;

      if (compute?.kind !== 'object') continue;

      for (const entry of compute.entries)
        if (entry.key && Object.hasOwn(types, entry.key))
          ranges.push(
            Decoration.widget({
              widget: new TypeHint(types[entry.key]!),
              side: 1,
            }).range(entry.keySpan.to),
          );
    }

    return { types, decorations: Decoration.set(ranges, true) };
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
});

function toCompletion(suggestion: ReturnType<typeof suggest> & object) {
  return suggestion.options.map((option): Completion => {
    const base: Completion = {
      label: option.label,
      type: option.type,
      ...(option.detail ? { detail: option.detail } : {}),
      ...(option.info ? { info: option.info } : {}),
      ...(option.boost !== undefined ? { boost: option.boost } : {}),
    };

    if (option.snippet) return snippetCompletion(option.snippet, base);

    return option.apply !== undefined ? { ...base, apply: option.apply } : base;
  });
}

function toDiagnostics(
  problems: readonly Problem[],
  length: number,
): Diagnostic[] {
  return problems
    .filter((problem) => problem.from < length)
    .map((problem) => ({
      from: problem.from,
      to: Math.min(problem.to, length),
      severity: problem.severity,
      message: problem.message,
      ...(problem.fix
        ? {
            actions: [
              {
                name: problem.fix.label,
                apply: (view: EditorView) =>
                  view.dispatch({
                    changes: {
                      from: problem.fix!.from,
                      to: problem.fix!.to,
                      insert: problem.fix!.insert,
                    },
                  }),
              },
            ],
          }
        : {}),
    }));
}

export interface EditorHandle {
  /** Insert text at the cursor, replacing the selection, and focus the editor. */
  insert(text: string): void;
}

export function Editor(props: {
  readonly code: string;
  readonly discovery: PlaygroundDiscovery | null;
  readonly problems: readonly Problem[];
  readonly fieldTypes: Readonly<Record<string, FieldType>>;
  readonly onChange: (code: string) => void;
  /** The document and cursor position, after each edit or selection change. */
  readonly onCursor: (code: string, pos: number) => void;
  readonly onRun: () => void;
  readonly handle?: (handle: EditorHandle | null) => void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Extensions read the latest props through this ref; the view is created once.
  const latest = useRef(props);

  latest.current = props;

  useEffect(() => {
    const complete = (context: CompletionContext): CompletionResult | null => {
      const result = suggest(
        context.state.doc.toString(),
        context.pos,
        latest.current.discovery,
        context.explicit,
      );

      if (!result) return null;

      return {
        from: result.from,
        options: toCompletion(result),
        ...(result.validFor ? { validFor: result.validFor } : {}),
      };
    };
    const hover = hoverTooltip((target, pos) => {
      const found = describeSql(
        target.state.doc.toString(),
        pos,
        latest.current.discovery,
      );

      if (!found) return null;

      return {
        pos: found.from,
        end: found.to,
        above: true,
        create: () => {
          const dom = document.createElement('div');
          const title = document.createElement('div');
          const name = document.createElement('code');
          const detail = document.createElement('span');

          dom.className = 'pg-hover';
          name.textContent = found.title;
          detail.className = 'pg-hover-type';
          detail.textContent = found.detail;
          title.append(name, detail);
          dom.append(title);

          if (found.note) {
            const note = document.createElement('div');

            note.className = 'pg-hover-note';
            note.textContent = found.note;
            dom.append(note);
          }

          return { dom };
        },
      };
    });

    const created = new EditorView({
      parent: parent.current!,
      state: EditorState.create({
        doc: latest.current.code,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          javascript(),
          syntaxHighlighting(highlight),
          theme,
          autocompletion({ override: [complete], icons: true }),
          lintGutter(),
          hover,
          sqlHighlighting,
          fieldTypes,
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                latest.current.onRun();

                return true;
              },
            },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...completionKeymap,
            ...lintKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              latest.current.onChange(update.state.doc.toString());

            if (update.docChanged || update.selectionSet)
              latest.current.onCursor(
                update.state.doc.toString(),
                update.state.selection.main.head,
              );
          }),
        ],
      }),
    });

    view.current = created;
    latest.current.onCursor(
      created.state.doc.toString(),
      created.state.selection.main.head,
    );
    latest.current.handle?.({
      insert(text) {
        const { from, to } = created.state.selection.main;

        created.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
        });
        created.focus();
      },
    });

    return () => {
      latest.current.handle?.(null);
      created.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const current = view.current;

    if (current)
      current.dispatch(
        setDiagnostics(
          current.state,
          toDiagnostics(props.problems, current.state.doc.length),
        ),
      );
  }, [props.problems]);

  useEffect(() => {
    view.current?.dispatch({ effects: setFieldTypes.of(props.fieldTypes) });
  }, [props.fieldTypes]);

  return <div className="pg-editor" ref={parent} />;
}
