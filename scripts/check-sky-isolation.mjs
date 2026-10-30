import assert from 'node:assert/strict';
import { build } from 'esbuild';

for (const entry of ['.', '/browser', '/embed', '/sky-image', '/appearances', '/journey']) {
  const specifier = `@found-in-space/pas-de-geant${entry === '.' ? '' : entry}`;
  const result = await build({ stdin: { contents: `export * from '${specifier}';`, resolveDir: process.cwd() },
    bundle: true, format: 'esm', platform: 'browser', splitting: true,
    outdir: '/tmp/geant-sky-isolation', write: false, metafile: true,
    external: ['three', 'three/*', '@found-in-space/spatial', '@found-in-space/touch-os',
      '@found-in-space/touch-os/*', '@found-in-space/voice-os'], logLevel: 'silent' });
  for (const input of Object.keys(result.metafile.inputs)) {
    assert.doesNotMatch(input, /deep-star-map-.*\.(?:webp|json)$/, `${specifier} bundles a separately published sky asset: ${input}`);
    assert.doesNotMatch(input, /\/(?:star-trees|star-octree-provider|three-star-field|hr-diagram|meta-sidecar-provider)\//,
      `${specifier} reaches a star dependency: ${input}`);
    assert.doesNotMatch(input, /\/(?:stars|spatial-star-pass)\.js$/, `${specifier} reaches catalog plugin code: ${input}`);
    if (entry !== '/appearances') assert.doesNotMatch(input, /\/appearances\/sun\.js$/,
      `${specifier} reaches the optional Sun implementation: ${input}`);
    if (entry !== '/sky-image') assert.doesNotMatch(input, /\/(?:sky-image\.js|deep-star-map-)/,
      `${specifier} reaches the optional sky image: ${input}`);
  }
  if (entry !== '/sky-image') for (const output of result.outputFiles) {
    assert.doesNotMatch(output.text, /data\.foundin\.space\/textures\/sky\//, `${specifier} includes the optional image URL.`);
  }
  console.log(`${specifier}: no star dependencies${entry === '/sky-image' ? '' : ' or background plugins'}.`);
}
