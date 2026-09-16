/**
 * Exporting a demo as a real Astro project.
 *
 * The live demo is served straight out of R2 the moment it is generated, so
 * the link in an outreach email works immediately. That is the right
 * behaviour for something that has to be ready in seconds — but it is not a
 * project anyone can hand over, put in a repository, or keep working on.
 *
 * So every demo is also written out as a complete Astro + Cloudflare Worker
 * project: `bun install && bun run deploy` and it is a Worker of its own on
 * its own domain. Astro cannot be *built* inside a Worker — there is no
 * process to run Vite in — so this generates the source and leaves the build
 * to a machine that has one.
 *
 * The generated project deliberately matches the conventions of this
 * repository: Astro with the Cloudflare adapter, static output, no
 * client-side framework.
 */

import type { Brief } from './brief';
import type { DesignPlanDraft } from './qualify';
import { escape, renderStylesheet, type DemoContext, type GeneratedFile } from './render';
import { renderDemoPage } from './render';
import type { StyleSpec } from './style';
import { styleFromBrief } from './style';

/** Slug-safe npm package name. */
function packageName(businessName: string): string {
  return (
    businessName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'demo-site'
  );
}

/**
 * Lift the rendered page into an Astro page.
 *
 * The body is carried over verbatim and the head is expressed as Astro
 * frontmatter plus a layout, which is what a person would have written by
 * hand — the point of the export is that it is a normal project to pick up,
 * not a generated artefact to fight.
 */
function astroIndexPage(html: string, plan: DesignPlanDraft): string {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const body = (bodyMatch?.[1] ?? '').trim();

  return `---
// Generated from the design plan. Edit freely — this is an ordinary Astro page.
import Layout from '../layouts/Layout.astro';

const title = ${JSON.stringify(plan.meta.title)};
const description = ${JSON.stringify(plan.meta.description)};
---

<Layout title={title} description={description}>
${body
  .split('\n')
  .map((line) => (line.trim() ? `  ${line}` : ''))
  .join('\n')}
</Layout>
`;
}

function astroLayout(brief: Brief, context: DemoContext): string {
  const fonts = brief.typography
    .filter((face) => face.source === 'google' && face.url.startsWith('https://fonts.googleapis.com/'))
    .map((face) => `    <link rel="stylesheet" href="${escape(face.url)}" />`);

  return `---
import '../styles/site.css';

interface Props {
  title: string;
  description?: string;
}

const { title, description = '' } = Astro.props;
---

<!doctype html>
<html lang="en-NZ">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <meta name="description" content={description} />
    <!--
      This is a concept built for ${escape(context.businessName)} without their
      involvement. Keep it out of search until they have seen it and agreed.
    -->
    <meta name="robots" content="noindex, nofollow" />
    <meta property="og:title" content={title} />
    <meta property="og:description" content={description} />
${fonts.length ? `    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\n${fonts.join('\n')}` : ''}
  </head>
  <body>
    <slot />
  </body>
</html>
`;
}

function readme(context: DemoContext, plan: DesignPlanDraft, host: string): string {
  return `# ${context.businessName} — concept

${plan.summary}

## What this is

A speculative one-page site built for ${context.businessName} by ${context.designerName}.
It was generated from a design plan and has **not** been commissioned, reviewed or
approved by ${context.businessName}. Every factual claim in the copy was taken from
their existing published material; nothing was invented. Check it anyway before
this goes anywhere a customer can see it.

Live at <https://${host}> until it is taken down.

## Why it serves them

${plan.strategy}

Objective: **${plan.objective}**.

## Running it

\`\`\`sh
bun install
bun run dev      # http://localhost:4321
bun run build
bun run deploy   # needs wrangler auth
\`\`\`

## Layout

- \`src/pages/index.astro\` — the page
- \`src/layouts/Layout.astro\` — head, fonts, metadata
- \`src/styles/site.css\` — the whole design system, one file
- \`public/images/\` — the photography used on the page

## The photography

${
    context.images.some((image) => image.generated)
      ? `Some of these pictures were **generated**, because their existing site did not
have usable photography of its own. They are marked "indicative" on the page and
are placeholders for art direction only — they are not photographs of
${context.businessName}, and they must be replaced before this is used for
anything real.

Generated: ${context.images.filter((image) => image.generated).length} of ${context.images.length}.`
      : `All ${context.images.length || 'of the'} pictures were carried over from their
existing site. They are theirs, not ours, and the rights have not been checked.`
  }

## Before this goes live for real

1. Replace every carried-over and generated image with photography you have the
   rights to use.
2. Confirm every claim in the copy with the client.
3. Remove \`noindex\` from the layout.
4. Point a real domain at it.
`;
}

export function renderAstroProject(
  plan: DesignPlanDraft,
  brief: Brief,
  context: DemoContext,
  host: string,
  spec: StyleSpec = styleFromBrief(brief),
): GeneratedFile[] {
  const name = packageName(context.businessName);
  const page = renderDemoPage(plan, brief, context, spec);

  const text = (path: string, content: string): GeneratedFile => ({
    path,
    content,
    contentType: path.endsWith('.json')
      ? 'application/json; charset=utf-8'
      : 'text/plain; charset=utf-8',
  });

  return [
    text(
      'package.json',
      JSON.stringify(
        {
          name,
          type: 'module',
          version: '0.1.0',
          private: true,
          packageManager: 'bun@1.4.0',
          scripts: {
            dev: 'astro dev',
            build: 'astro build',
            preview: 'astro build && wrangler dev',
            deploy: 'astro build && wrangler deploy',
          },
          dependencies: {
            '@astrojs/cloudflare': '^14.3.1',
            astro: '^7.3.2',
          },
          devDependencies: {
            wrangler: '^4.131.1',
          },
        },
        null,
        2,
      ) + '\n',
    ),
    text(
      'astro.config.mjs',
      `// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  // The page is static: there is nothing here that needs a server render.
  output: 'static',
  adapter: cloudflare(),
});
`,
    ),
    text(
      'wrangler.jsonc',
      `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": ${JSON.stringify(name)},
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  // \`main\` and \`assets\` are set by the Astro Cloudflare adapter at build
  // time — do not add them here, it will fail the build.
  "observability": { "enabled": true }
}
`,
    ),
    text(
      'tsconfig.json',
      JSON.stringify({ extends: 'astro/tsconfigs/strict' }, null, 2) + '\n',
    ),
    text('.gitignore', 'node_modules\ndist\n.astro\n.wrangler\n.dev.vars\n'),
    text('README.md', readme(context, plan, host)),
    text('src/layouts/Layout.astro', astroLayout(brief, context)),
    text('src/pages/index.astro', astroIndexPage(page, plan)),
    { path: 'src/styles/site.css', content: renderStylesheet(brief, spec), contentType: 'text/css; charset=utf-8' },
    text('public/robots.txt', 'User-agent: *\nDisallow: /\n'),
    text(
      'DESIGN-PLAN.json',
      JSON.stringify({ plan, style: spec, brief: { ...brief, assetKeys: undefined } }, null, 2) + '\n',
    ),
  ];
}
