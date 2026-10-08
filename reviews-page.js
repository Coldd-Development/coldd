/* Renders every approved review (window.__REVIEWS, populated by catalog.js
   from the real `reviews` table, approved-only - the same admin moderation
   queue that already gates product-page reviews) into the /reviews page's
   grid. Nothing to do here beyond render: approving/hiding a review in
   admin is what adds or removes it from this page - there's no separate
   publish step and no page-specific data of its own. */
(function () {
  var grid = document.getElementById('allReviewsGrid');
  if (!grid) return;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var STAR_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.1l2.95 5.98 6.6.96-4.78 4.66 1.13 6.57L12 17.16l-5.9 3.11 1.13-6.57L2.45 9.04l6.6-.96z"/></svg>';
  function starsHtml(n) {
    var h = '';
    for (var i = 0; i < 5; i++) h += (i < n ? STAR_SVG : '<span class="off">' + STAR_SVG + '</span>');
    return h;
  }

  // Same dropdown pattern as the catalog's own sort control (.sort-field/
  // .sort-btn/.sort-menu/.sort-opt) - a sort, not a filter (matches what
  // that control actually is on the catalog page: Recommended/Featured/
  // Lowest Price/etc, never a way to hide products).
  var sortField = document.getElementById('reviewFilterField');
  var sortBtn = document.getElementById('reviewFilterBtn');
  var sortMenu = document.getElementById('reviewFilterMenu');
  var sortVal = document.getElementById('reviewFilterVal');
  var sortOpts = sortMenu ? Array.prototype.slice.call(sortMenu.querySelectorAll('.sort-opt')) : [];
  var activeSort = 'newest';

  function closeSortMenu() {
    if (sortField) sortField.classList.remove('open');
    if (sortMenu) sortMenu.hidden = true;
    if (sortBtn) sortBtn.setAttribute('aria-expanded', 'false');
  }
  function openSortMenu() {
    if (sortField) sortField.classList.add('open');
    if (sortMenu) sortMenu.hidden = false;
    if (sortBtn) sortBtn.setAttribute('aria-expanded', 'true');
  }
  if (sortBtn) sortBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (sortMenu && sortMenu.hidden) openSortMenu(); else closeSortMenu();
  });
  sortOpts.forEach(function (o) {
    o.addEventListener('click', function () {
      activeSort = o.getAttribute('data-filter');
      if (sortVal) sortVal.textContent = o.querySelector('span') ? o.querySelector('span').textContent : o.textContent;
      sortOpts.forEach(function (opt) {
        var active = opt === o;
        opt.classList.toggle('active', active);
        opt.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      closeSortMenu();
      render();
    });
  });
  document.addEventListener('click', function (e) { if (sortField && !sortField.contains(e.target)) closeSortMenu(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSortMenu(); });

  function sortReviews(list) {
    var sorted = list.slice();
    if (activeSort === 'highest') sorted.sort(function (a, b) { return (b.stars || 0) - (a.stars || 0); });
    else if (activeSort === 'lowest') sorted.sort(function (a, b) { return (a.stars || 0) - (b.stars || 0); });
    else sorted.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
    return sorted;
  }

  function render() {
    var reviews = sortReviews(window.__REVIEWS || []);
    if (!reviews.length) { grid.innerHTML = '<p class="pd-empty">No reviews yet.</p>'; return; }

    var catalogById = {};
    (window.__CATALOG || []).forEach(function (p) { catalogById[p.id] = p; });

    grid.innerHTML = reviews.map(function (r) {
      var initial = (r.user || '?').trim().charAt(0).toUpperCase() || '?';
      var product = catalogById[r.productId];
      // A general review has no product: show who wrote it (role / company) instead.
      var sub = r.byline || (product ? product.title : '');
      var avatar = r.avatar
        ? '<img class="ra" src="' + esc(r.avatar) + '" alt="" width="38" height="38" />'
        : '<span class="ra">' + esc(initial) + '</span>';
      return '<article class="glass review reveal">' +
        '<div class="stars" aria-label="' + (r.stars || 0) + ' out of 5">' + starsHtml(r.stars || 0) + '</div>' +
        '<p>"' + esc(r.text) + '"</p>' +
        '<div class="review-by">' + avatar + '<span class="rn">' + esc(r.user) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span></div>' +
        '</article>';
    }).join('');
    // app.js's scroll-reveal observer already ran by the time this fires
    // (this script is chained behind app.js in catalog.js's data-then), so
    // these newly-injected .reveal cards need to be handed to it explicitly
    // or they stay at their default html.js-scoped opacity:0 forever -
    // fully rendered, real content, permanently invisible. See app.js.
    if (window.__scanReveal) window.__scanReveal(grid);
  }

  // catalog.js has already resolved window.__REVIEWS/__CATALOG by the time
  // this script runs (it's loaded via catalog.js's own data-then chain,
  // which only fires after that fetch settles) - render immediately.
  render();
})();
