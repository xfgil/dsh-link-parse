import { apply, name, inject } from '../lib/index.js';

console.log('name=', name, 'inject=', inject.join(','));
const registered = [];
const ctx = {
  logger: { info: (...a) => console.log('[log]', ...a) },
  inject: (deps, fn) => {
    const toolCtx = {
      effect: (fn2) => fn2(),
      tools: { register: (spec) => { registered.push(spec); return () => {}; } },
    };
    fn(toolCtx);
  },
};
apply(ctx, { mediaDir: 'D:\\tmp\\media' });
console.log('tools:', registered.map((t) => t.name));
for (const t of registered) {
  console.log('---', t.name);
  console.log('  params.type =', t.parameters?.type, 'required =', JSON.stringify(t.parameters?.required));
  console.log('  output.schema =', JSON.stringify(t.output?.schema));
}
// 跑一下 execute，确认形状与 output.schema 对得上
const parseTool = registered.find((t) => t.name === 'link_parse');
const r = await parseTool.execute({ url: 'https://github.com/Qfxaile/astrbot_plugin_multi_parser' });
console.log('execute ok:', r.ok, r.platform, r.kind, '|', r.title, '| stars', r.stats?.stars);
