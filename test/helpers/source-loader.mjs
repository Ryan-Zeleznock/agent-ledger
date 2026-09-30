// Child-process tests execute the actual TS sources using Node's type stripping.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js') && specifier.startsWith('.') && context.parentURL) {
      const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(source)) return nextResolve(source.href, context);
    }
    return nextResolve(specifier, context);
  },
});
