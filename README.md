# Wildlife Photography

> A personal photography site — built fast, served static, kept simple.

**Live at [danielgrant.photos](https://danielgrant.photos)**

---

## Overview

Personal site showcasing wildlife photography. The gallery runs as a React
island inside an otherwise static Astro build, with a PhotoSwipe lightbox for
full-resolution viewing and Lenis for smooth scrolling.

Photos are stored in Cloudflare R2 and the site is served as a static build by
Cloudflare Pages.

## Tech Stack

| Layer         | Tool             |
| ------------- | ---------------- |
| Framework     | Astro            |
| Styling       | Tailwind CSS v4  |
| Gallery       | React (island)   |
| Lightbox      | PhotoSwipe       |
| Smooth scroll | Lenis            |
| Image store   | Cloudflare R2    |
| Hosting       | Cloudflare Pages |

## Development

```bash
npm install      # install dependencies
npm run dev      # start the dev server
npm run build    # build for production
npm run preview  # preview the production build
```

---

<sub>© Daniel Grant</sub>
