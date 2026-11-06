const menu = document.querySelector('.menu');
const header = document.querySelector('header');

// Keep the scroll offset equal to the nav bar's real height
// (it changes between desktop and phone layouts, and when the phone menu opens)
const setHeaderHeight = () => {
  if (header) {
    document.documentElement.style.setProperty('--header-height', `${header.offsetHeight}px`);
  }
};
setHeaderHeight();
if (header) new ResizeObserver(setHeaderHeight).observe(header);

menu?.addEventListener('click', () => {
  const isExpanded = menu.getAttribute('aria-expanded') === 'true';
  menu.setAttribute('aria-expanded', `${!isExpanded}`);
});

// Close the phone menu after picking a section, so the page slides into view
document.querySelectorAll('#main-menu a').forEach((link) => {
  link.addEventListener('click', () => {
    menu?.setAttribute('aria-expanded', 'false');
    setHeaderHeight(); // update now, before the browser starts scrolling
  });
});
