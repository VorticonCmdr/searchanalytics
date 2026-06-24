import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import inject from '@rollup/plugin-inject';
import { resolve } from 'path';

export default defineConfig({
  root: 'src',
  publicDir: false,
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index:   resolve(__dirname, 'src/html/index.html'),
        days:    resolve(__dirname, 'src/html/days.html'),
        hourly:  resolve(__dirname, 'src/html/hourly.html'),
        options: resolve(__dirname, 'src/html/options.html'),
      },
    },
  },
  plugins: [
    // Provide jQuery and bb as globals for UMD plugins (bootstrap-table, tableexport)
    // Restricted to JS/MJS files only — CSS files must not be parsed by this plugin
    {
      ...inject({
        $:      ['jquery', 'default'],
        jQuery: ['jquery', 'default'],
        bb:     ['billboard.js', 'default'],
        include: ['**/*.js', '**/*.mjs', '**/*.ts'],
      }),
      enforce: 'pre',
    },
    viteStaticCopy({
      // Paths are relative to the Vite root (src/), so use ../ to reach project root
      targets: [
        { src: '../manifest.json',                                                    dest: '.' },
        { src: '../icons',                                                            dest: '.' },
        // Service worker: copied verbatim, not bundled (MV3 constraint)
        { src: './js/background.js',                                                  dest: 'js/' },
        // Billboard CSS: two separate files for media-query dark mode
        { src: '../node_modules/billboard.js/dist/billboard.min.css',                dest: 'css/' },
        { src: '../node_modules/billboard.js/dist/theme/dark.min.css', rename: 'billboard.dark.min.css', dest: 'css/' },
      ],
    }),
  ],
});
