/* Renders the /reviews page's grid from window.__REVIEWS (populated by catalog.js from the real
   reviews table, approved-only). Only 4 and 5 star reviews and Roblox "recommends" show here
   (product pages show every review). Glowing reviews come first and four-star or critical ones
   (app.js's window.__reviewCritical) after them; within each group the order is random on each
   visit but weighted toward the best looking reviews, so the strongest ones usually lead without
   the page always opening on the same few. Each card is app.js's window.__reviewCardHtml, the
   same one the homepage uses. */
(function () {
  var grid = document.getElementById('allReviewsGrid');
  if (!grid || !window.__reviewCardHtml) return;

  function good(r) { return r.stars >= 4 || (!(r.stars > 0) && r.recommended === true); }

  // How good a card looks: a few sentences beat a word or a wall of text, a real avatar and a
  // linked product fill the card, five stars beat four, and written-with-care text (capital
  // first letter, punctuation) reads better.
  function looks(r, product) {
    var text = String(r.text || '').trim();
    var words = text ? text.split(/\s+/).length : 0;
    var w = Math.min(words, 40) / 40;
    if (words > 90) w *= 0.7;
    if (r.stars === 5 || r.recommended === true) w += 0.3; else if (r.stars === 4) w += 0.1;
    if (r.avatar) w += 0.3;
    if (product) w += 0.2;
    if (/^[A-Z"']/.test(text) && /[.!?)]/.test(text)) w += 0.15;
    return Math.max(0.05, w);
  }

  function render() {
    var catalogById = {};
    (window.__CATALOG || []).forEach(function (p) { catalogById[p.id] = p; });
    // Weighted shuffle: each review draws random^(1/weight), so a better looking review tends
    // to land higher while every visit still gets a different order.
    var reviews = (window.__REVIEWS || []).filter(good).map(function (r) {
      var product = catalogById[r.productId];
      var critical = window.__reviewCritical ? window.__reviewCritical(r) : r.stars !== 5;
      return { r: r, product: product, low: critical ? 1 : 0, key: Math.pow(Math.random(), 1 / looks(r, product)) };
    }).sort(function (a, b) { return a.low - b.low || b.key - a.key; });
    if (!reviews.length) { grid.innerHTML = '<p class="pd-empty">No reviews yet.</p>'; return; }
    grid.innerHTML = reviews.map(function (x) { return window.__reviewCardHtml(x.r, x.product); }).join('');
    // app.js's scroll-reveal observer already ran by the time this fires (this script is chained
    // behind app.js in catalog.js's data-then), so the new .reveal cards are handed to it here or
    // they would stay at opacity 0.
    if (window.__scanReveal) window.__scanReveal(grid);
  }
  render();
})();
