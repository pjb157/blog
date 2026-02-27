# peterbhabra.com

Personal blog. Built with Jekyll, hosted on GitHub Pages.

## Dev setup

```bash
bundle install
bundle exec jekyll serve --livereload
```

Open `http://localhost:4000/blog/`

## Writing a post

Create `_posts/YYYY-MM-DD-title.md`:

```yaml
---
layout: post
title: Your title
date: 2026-02-27
tags: [tag1, tag2]
---

Content here.
```

## Deploying

Push to `main`. GitHub Actions handles the rest.
