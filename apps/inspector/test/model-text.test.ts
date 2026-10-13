import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ModelText } from '../src/screens/AgentScreen.js';

const render = (text: string) =>
  renderToStaticMarkup(createElement(ModelText, { text }));

it('renders GitHub-flavoured Markdown from the model', () => {
  const html = render(
    '## Customers\n\nFound **3** with `status = active`:\n\n- Acme\n- Globex\n\n| Name | Plan |\n|---|---|\n| Acme | Pro |\n\nSee [the docs](https://example.com).',
  );

  expect(html).toContain('<h2>Customers</h2>');
  expect(html).toContain('<strong>3</strong>');
  expect(html).toContain('<code>status = active</code>');
  expect(html).toContain('<li>Acme</li>');
  expect(html).toContain('<td>Pro</td>');
  expect(html).toContain(
    '<a href="https://example.com" target="_blank" rel="noreferrer">the docs</a>',
  );
});

it('renders fenced code with the inspector code view', () => {
  const html = render('```js\nconst x = 1;\n```');

  expect(html).toContain('class="agent-code"');
  expect(html).toContain('<span class="tok-kw">const </span>');
  expect(html).not.toContain('<pre');
});

it('never renders raw HTML from the model', () => {
  const html = render('<script>alert(1)</script>\n\n<b>bold</b>');

  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<b>');
});

it('closes half-written syntax while a reply streams', () => {
  expect(render('Found **3 cust')).toContain('<strong>3 cust</strong>');
  expect(render('Run `relate de')).toContain('<code>relate de</code>');
  expect(render('Here:\n\n```js\nconst y')).toContain('class="agent-code"');
});
