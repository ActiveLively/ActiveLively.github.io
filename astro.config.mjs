// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';


import preact from '@astrojs/preact';


// https://astro.build/config
export default defineConfig({
  site: 'https://activelively.github.io',
  integrations: [react(), preact()],
  // The old separate pages now live as sections on the home page
  redirects: {
    '/about': '/#about',
    '/research': '/#works',
    '/works': '/#works',
    '/photography': '/#photography',
  },
  vite: {
    plugins: [tailwindcss()]
  }
});