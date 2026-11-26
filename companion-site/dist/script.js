const menu = document.querySelector('.menu-button');
const mobileNav = document.querySelector('#mobile-nav');
if (menu && mobileNav) {
  menu.addEventListener('click', () => {
    const open = menu.getAttribute('aria-expanded') === 'true';
    menu.setAttribute('aria-expanded', String(!open));
    mobileNav.hidden = open;
  });
  mobileNav.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
    menu.setAttribute('aria-expanded', 'false');
    mobileNav.hidden = true;
  }));
}
