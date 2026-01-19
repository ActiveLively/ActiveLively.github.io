// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';


import preact from '@astrojs/preact';


// https://astro.build/config
export default defineConfig({
  site: 'https://activelively.github.io',
  integrations: [react(), preact()],
  vite: {
    plugins: [tailwindcss()]
  }
});