// Our own scroll-to-top FAB. Material's native `.md-top` is hidden in extra.css
// because its JS keeps repositioning it (inline `top`, `transform`, `hidden` by
// scroll direction); this button is fixed to the bottom-left corner, appears
// once the page is scrolled past a small threshold, and never moves.
const SCROLL_TOP_THRESHOLD = 200; // px

function setupScrollTopButton() {
  if (window._sfTopButton) return; // one button for the life of the page

  const button = document.createElement("button");
  button.type = "button";
  button.className = "sf-top";
  button.setAttribute("aria-label", "Scroll back to top");
  button.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M13 20h-2V8l-5.5 5.5-1.42-1.42L12 4.16l7.92 7.92-1.42 1.42L13 8z"/></svg>';
  button.addEventListener("click", () => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  });
  document.body.appendChild(button);
  window._sfTopButton = button;

  const sync = () => {
    const y = window.scrollY || document.documentElement.scrollTop || 0;
    button.classList.toggle("sf-top--show", y > SCROLL_TOP_THRESHOLD);
  };
  window.addEventListener("scroll", sync, { passive: true });
  sync();
}

// Collapsible "On this page" (ToC), like Claude Docs. A chevron in the ToC
// header hides the panel and lets the content column reclaim the width; a slim
// pinned button brings it back. The state lives in localStorage so it persists
// across pages and reloads. The CSS (body.sf-toc-collapsed) does the layout.
const TOC_STORAGE_KEY = "sf-toc-collapsed";

const CHEVRON_RIGHT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>';
const CHEVRON_LEFT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M15.41 16.59 10.83 12l4.58-4.59L14 6l-6 6 6 6z"/></svg>';
// "Listado": tres rayitas con puntos a la izquierda (como la referencia).
const LIST_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M4 6h2v2H4zm0 5h2v2H4zm0 5h2v2H4zm4-10h12v2H8zm0 5h12v2H8zm0 5h12v2H8z"/>' +
  "</svg>";

function scrollDocToTop() {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
}

function tocIsCollapsed() {
  try {
    return localStorage.getItem(TOC_STORAGE_KEY) === "1";
  } catch (e) {
    return false;
  }
}

function setTocCollapsed(collapsed) {
  document.body.classList.toggle("sf-toc-collapsed", collapsed);
  try {
    localStorage.setItem(TOC_STORAGE_KEY, collapsed ? "1" : "0");
  } catch (e) {
    /* storage blocked (private mode); state just won't persist */
  }
  if (window._sfTocToggle) {
    window._sfTocToggle.setAttribute("aria-expanded", String(!collapsed));
    window._sfTocToggle.setAttribute(
      "aria-label",
      collapsed ? "Show table of contents" : "Hide table of contents"
    );
  }
  if (window._sfTocReopen) {
    window._sfTocReopen.setAttribute("aria-hidden", String(!collapsed));
  }
}

function setupTocToggle() {
  const toc = document.querySelector(
    '.md-sidebar--secondary[data-md-type="toc"]'
  );

  // The ToC only renders when a page actually has one. When it's missing (a
  // page with no headings) make sure we don't leave the content stuck in the
  // collapsed-width layout from a previous page.
  if (!toc) {
    document.body.classList.remove("sf-toc-collapsed");
    return;
  }

  const title = toc.querySelector(".md-nav__title");
  if (title && !title.querySelector(".sf-toc-toggle")) {
    // Botón-píldora de toggle: SOLO el chevron, en su píldora redonda. Va a la
    // IZQUIERDA del rótulo (como en Claude Docs).
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "sf-toc-toggle";
    toggle.innerHTML =
      '<span class="sf-toc-chevron" aria-hidden="true">' + CHEVRON_RIGHT + "</span>";
    toggle.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      setTocCollapsed(!document.body.classList.contains("sf-toc-collapsed"));
    });
    title.insertBefore(toggle, title.firstChild);
    window._sfTocToggle = toggle;

    // El icono de "listado" es parte del rótulo: va pegado a la izquierda del
    // texto "Table of contents", no dentro de la píldora del chevron.
    const icon = document.createElement("span");
    icon.className = "sf-toc-list-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = LIST_ICON;
    title.insertBefore(icon, toggle.nextSibling);

    // El rótulo "Table of contents" (texto + icono de listado) lleva al inicio
    // de la página con scroll suave. El título es un <label for="__toc">, así
    // que prevenimos su acción nativa (togglear el checkbox del drawer).
    title.classList.add("sf-toc-title--clickable");
    title.addEventListener("click", (ev) => {
      // Clicks sobre el toggle se manejan aparte; no scrollear en ese caso.
      if (ev.target.closest(".sf-toc-toggle")) return;
      ev.preventDefault();
      scrollDocToTop();
    });
  }

  // Píldora pegada al borde derecho que reaparece el ToC cuando está colapsado:
  // chevron-izquierda + icono de listado. Mismo estilo que el toggle. Se crea
  // una vez y se reusa entre navegaciones instantáneas.
  if (!window._sfTocReopen) {
    const reopen = document.createElement("button");
    reopen.type = "button";
    reopen.className = "sf-toc-reopen";
    reopen.setAttribute("aria-label", "Show table of contents");
    reopen.innerHTML =
      '<span class="sf-toc-chevron" aria-hidden="true">' +
      CHEVRON_LEFT +
      "</span>" +
      '<span class="sf-toc-list-icon" aria-hidden="true">' +
      LIST_ICON +
      "</span>";
    reopen.addEventListener("click", () => setTocCollapsed(false));
    document.body.appendChild(reopen);
    window._sfTocReopen = reopen;
  }

  // Re-apply the stored state for this page.
  setTocCollapsed(tocIsCollapsed());
}

// Eyebrow/kicker sobre el H1, como Claude Docs: el nombre del grupo del nav
// izquierdo al que pertenece la página (p. ej. "GETTING STARTED"), en pequeño,
// mayúsculas y color accent. Se inyecta justo antes del primer H1 del contenido.
function setupH1Eyebrow() {
  const content = document.querySelector(".md-content__inner");
  if (!content) return;

  const h1 = content.querySelector("h1");
  if (!h1) return;

  // Grupo de primer nivel activo en el nav izquierdo.
  const activeSection = document.querySelector(
    ".md-nav--primary > .md-nav__list > .md-nav__item--section.md-nav__item--active > .md-nav__link .md-ellipsis, " +
      ".md-nav--primary > .md-nav__list > .md-nav__item--active.md-nav__item--section > .md-nav__link .md-ellipsis"
  );
  const label = activeSection ? activeSection.textContent.trim() : "";

  const existing = content.querySelector(".sf-eyebrow");

  // Sin grupo (o el título del H1 coincide con el grupo): sin eyebrow.
  if (!label || label.toLowerCase() === h1.textContent.trim().toLowerCase()) {
    if (existing) existing.remove();
    return;
  }

  if (existing) {
    existing.textContent = label;
    return;
  }

  const eyebrow = document.createElement("p");
  eyebrow.className = "sf-eyebrow";
  eyebrow.textContent = label;
  h1.parentNode.insertBefore(eyebrow, h1);
}

document$.subscribe(() => {
  setupScrollTopButton();
  setupTocToggle();
  setupH1Eyebrow();
});
