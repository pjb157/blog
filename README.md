# Cyberpunk Blog

A dark, neon-themed personal blog built with Jekyll and hosted on GitHub Pages.

## Features

- Dark cyberpunk aesthetic with neon accents
- Fully responsive design
- Fast and lightweight (no external dependencies)
- SEO optimized
- RSS feed included
- Syntax highlighting for code blocks
- Mobile-friendly navigation
- Glitch text effects
- Clean, readable typography

## Quick Start

### Prerequisites

- Ruby 2.7 or higher
- Bundler

### Local Development

1. **Install dependencies**
   ```bash
   bundle install
   ```

2. **Run the development server**
   ```bash
   bundle exec jekyll serve
   ```

3. **View your site**
   Open your browser to `http://localhost:4000`

The site will automatically rebuild when you make changes to files.

### Adding Live Reload (Optional)

For automatic browser refresh on file changes:

```bash
bundle exec jekyll serve --livereload
```

## Customization

### Site Information

Edit `_config.yml` to customize:

```yaml
title: Your Blog Title
description: Your blog description
author: Your Name
email: your.email@example.com
url: "https://yourusername.github.io"
```

### Social Links

Update the social links in `_includes/footer.html`:

```html
<li><a href="https://github.com/yourusername">GitHub</a></li>
<li><a href="https://twitter.com/yourusername">Twitter</a></li>
```

### Color Scheme

Customize the cyberpunk theme colors in `assets/css/style.css`:

```css
:root {
  --bg-primary: #0a0e27;      /* Main background */
  --bg-secondary: #151b3d;    /* Card backgrounds */
  --accent-cyan: #00f6ff;     /* Primary accent */
  --accent-pink: #ff006e;     /* Secondary accent */
  --accent-purple: #b537f2;   /* Tertiary accent */
}
```

## Writing Posts

### Create a New Post

1. Create a new file in `_posts/` with the format: `YYYY-MM-DD-title.md`

2. Add front matter:
   ```yaml
   ---
   layout: post
   title: "Your Post Title"
   date: 2025-12-26 10:00:00 -0000
   tags: [tag1, tag2, tag3]
   ---
   ```

3. Write your content in Markdown

### Example Post

```markdown
---
layout: post
title: "My First Post"
date: 2025-12-26 10:00:00 -0000
tags: [introduction, blogging]
---

This is my first post!

## Section Heading

Some content here...

\`\`\`javascript
console.log('Code blocks are supported!');
\`\`\`
```

## Deploying to GitHub Pages

### Option 1: Automatic Deployment (Recommended)

1. **Create a new repository** on GitHub named `yourusername.github.io`

2. **Push your code**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/yourusername/yourusername.github.io.git
   git push -u origin main
   ```

3. **Enable GitHub Pages**
   - Go to your repository settings
   - Navigate to "Pages" section
   - Under "Source", select "Deploy from a branch"
   - Select `main` branch and `/ (root)` folder
   - Click "Save"

4. **Wait a few minutes** and your site will be live at `https://yourusername.github.io`

### Option 2: GitHub Actions (Advanced)

Create `.github/workflows/jekyll.yml`:

```yaml
name: Deploy Jekyll site to Pages

on:
  push:
    branches: ["main"]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ruby/setup-ruby@v1
        with:
          ruby-version: '3.1'
          bundler-cache: true
      - name: Build with Jekyll
        run: bundle exec jekyll build
      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

## Project Structure

```
.
├── _config.yml           # Site configuration
├── _includes/            # Reusable components
│   ├── header.html
│   └── footer.html
├── _layouts/             # Page templates
│   ├── default.html
│   ├── home.html
│   └── post.html
├── _posts/               # Blog posts
│   └── YYYY-MM-DD-title.md
├── assets/
│   ├── css/
│   │   └── style.css     # Custom styles
│   └── js/
│       └── main.js       # JavaScript
├── about.md              # About page
├── archive.html          # Archive page
├── index.html            # Homepage
├── Gemfile               # Ruby dependencies
└── README.md             # This file
```

## Troubleshooting

### Port already in use
```bash
bundle exec jekyll serve --port 4001
```

### Clear cache and rebuild
```bash
bundle exec jekyll clean
bundle exec jekyll build
```

### GitHub Pages not updating
- Check the Actions tab in your repository
- Make sure GitHub Pages is enabled in settings
- Wait a few minutes for deployment

## Customization Ideas

- Add a dark/light mode toggle
- Integrate a comments system (Disqus, utterances)
- Add a search functionality
- Create category pages
- Add author profiles for multi-author blogs
- Integrate analytics (Google Analytics, Plausible)

## Resources

- [Jekyll Documentation](https://jekyllrb.com/docs/)
- [GitHub Pages Documentation](https://docs.github.com/en/pages)
- [Markdown Guide](https://www.markdownguide.org/)
- [Liquid Template Language](https://shopify.github.io/liquid/)

## License

This theme is free to use and modify. Attribution appreciated but not required.

---

Built with Jekyll and hosted on GitHub Pages.
