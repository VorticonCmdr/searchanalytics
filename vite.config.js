import { defineConfig } from 'vite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectRoot = import.meta.dirname;
const fromRoot = (path) => resolve(projectRoot, path);

// Files the extension needs verbatim (not bundled), as [source, path inside dist/].
// Emitted through Rollup, so they can only ever land inside build.outDir.
const extensionFiles = [
  ['manifest.json', 'manifest.json'],
  ['icons/logo-128.png', 'icons/logo-128.png'],
  ['icons/logo-180.png', 'icons/logo-180.png'],
  ['icons/logo-192.png', 'icons/logo-192.png'],
  // Service worker: copied verbatim, not bundled (MV3 constraint)
  ['src/js/background.js', 'js/background.js'],
  // Theme switcher: classic <head> script so the colour scheme applies before first paint
  ['src/js/theme.js', 'js/theme.js'],
  // Billboard CSS: two separate files for media-query dark mode
  ['node_modules/billboard.js/dist/billboard.min.css', 'css/billboard.min.css'],
  ['node_modules/billboard.js/dist/theme/dark.min.css', 'css/billboard.dark.min.css'],
];

function copyExtensionFiles(files) {
  return {
    name: 'copy-extension-files',
    apply: 'build',
    async generateBundle() {
      for (const [src, fileName] of files) {
        this.addWatchFile(fromRoot(src));
        this.emitFile({ type: 'asset', fileName, source: await readFile(fromRoot(src)) });
      }
    },
  };
}

export default defineConfig({
  root: 'src',
  publicDir: false,
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index:   fromRoot('src/html/index.html'),
        days:    fromRoot('src/html/days.html'),
        hourly:  fromRoot('src/html/hourly.html'),
        options: fromRoot('src/html/options.html'),
      },
    },
  },
  plugins: [copyExtensionFiles(extensionFiles)],
});
