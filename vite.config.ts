import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

export default defineConfig({
  // 相対パスで出力する(GitHub Pages の https://<user>.github.io/<repo>/ のようなサブパスでも動く)
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022' },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
});
