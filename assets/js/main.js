// Mobile Navigation Toggle
document.addEventListener('DOMContentLoaded', function() {
  const navToggle = document.querySelector('.nav-toggle');
  const navLinks = document.querySelector('.nav-links');

  document.querySelectorAll('a[href]').forEach(function(link) {
    const url = new URL(link.href, window.location.href);

    if ((url.protocol === 'http:' || url.protocol === 'https:') &&
        url.origin !== window.location.origin) {
      const rel = new Set((link.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
      rel.add('noopener');
      rel.add('noreferrer');
      link.target = '_blank';
      link.setAttribute('rel', Array.from(rel).join(' '));
    }
  });

  if (navToggle) {
    navToggle.addEventListener('click', function() {
      navLinks.classList.toggle('active');
    });
  }

  // Close mobile menu when clicking outside
  document.addEventListener('click', function(event) {
    if (navLinks && navLinks.classList.contains('active')) {
      if (!event.target.closest('.nav')) {
        navLinks.classList.remove('active');
      }
    }
  });
});
