'use strict';

document.documentElement.classList.add('js-ready');

const formatMoney = (value) => `£${Number(value).toFixed(2)}`;
const setText = (id, value) => {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
};

const yearNode = document.getElementById('year');
if (yearNode) yearNode.textContent = new Date().getFullYear();

fetch('data/state.json', { cache: 'no-store' })
  .then((response) => {
    if (!response.ok) throw new Error('Model state unavailable');
    return response.json();
  })
  .then((data) => {
    const costs = data.costs || {};
    const kpis = data.kpis || {};

    if (costs.proj_deliveries_per_day) setText('metric-deliveries', Math.round(costs.proj_deliveries_per_day).toLocaleString('en-GB'));
    if (costs.proj_margin_pct) setText('metric-margin', `${Math.round(costs.proj_margin_pct)}%`);
    if (kpis.on_time_pct != null) setText('metric-ontime', `${Math.round(kpis.on_time_pct)}%`);
    if (kpis.wh_per_delivery) setText('metric-energy', `${Math.round(kpis.wh_per_delivery)} Wh`);
    if (costs.proj_cost_per_delivery) {
      setText('hero-cost', formatMoney(costs.proj_cost_per_delivery));
      setText('cost-delivery', formatMoney(costs.proj_cost_per_delivery));
    }
    if (costs.proj_revenue_per_delivery) setText('revenue-delivery', formatMoney(costs.proj_revenue_per_delivery));
    if (costs.proj_profit_per_delivery) setText('profit-delivery', formatMoney(costs.proj_profit_per_delivery));
  })
  .catch(() => {
    // The page keeps its illustrative fallback values when the live model is offline.
  });

const topic = new URLSearchParams(window.location.search).get('topic');
const topicSelect = document.getElementById('contact-topic');
if (topicSelect && topic) {
  const roleTopic = topic.startsWith('role-') ? 'careers' : topic;
  if ([...topicSelect.options].some((option) => option.value === roleTopic)) {
    topicSelect.value = roleTopic;
  }
}

const contactForm = document.getElementById('contact-form');
if (contactForm) {
  contactForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(contactForm);
    const subject = `Locust ${data.get('topic')} enquiry from ${data.get('name')}`;
    const body = [
      `Name: ${data.get('name')}`,
      `Email: ${data.get('email')}`,
      `Organisation: ${data.get('organisation') || 'Not provided'}`,
      `Topic: ${data.get('topic')}`,
      topic && topic.startsWith('role-') ? `Role: ${topic.replace('role-', '').replaceAll('-', ' ')}` : '',
      '',
      data.get('message'),
    ].filter(Boolean).join('\n');
    window.location.href = `mailto:hello@locust.aero?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  });
}

const siteNav = document.querySelector('.site-nav');
if (siteNav) {
  const menuButton = document.createElement('button');
  menuButton.className = 'menu-toggle';
  menuButton.type = 'button';
  menuButton.setAttribute('aria-label', 'Open navigation');
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.innerHTML = '<i></i><i></i>';
  siteNav.appendChild(menuButton);
  menuButton.addEventListener('click', () => {
    const open = siteNav.classList.toggle('menu-open');
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    document.body.classList.toggle('nav-open', open);
  });
  siteNav.querySelectorAll('nav a').forEach((link) => link.addEventListener('click', () => {
    siteNav.classList.remove('menu-open');
    document.body.classList.remove('nav-open');
  }));
}

const progress = document.createElement('div');
progress.className = 'scroll-progress';
document.body.appendChild(progress);
const updateProgress = () => {
  const available = document.documentElement.scrollHeight - window.innerHeight;
  progress.style.transform = `scaleX(${available > 0 ? window.scrollY / available : 0})`;
  siteNav?.classList.toggle('nav-scrolled', window.scrollY > 40);
};
window.addEventListener('scroll', updateProgress, { passive: true });
updateProgress();

const revealSelectors = [
  '.section', '.audience-card', '.dark-block', '.council-section',
  '.pilot-banner', '.contact-section', '.page-metrics', '.numbered-grid article',
  '.business-ladder article', '.role-list a', '.offer-grid article',
  '.process-section li', '.contact-meta article', '.capital-section',
  '.stakeholder-grid article', '.mission-principles li', '.source-grid a',
  '.pricing-calculator-section', '.service-price-grid article', '.pricing-rules',
  '.claim-key article', '.reference-list article', '.outcome-grid article',
];
const revealNodes = document.querySelectorAll(revealSelectors.join(','));
revealNodes.forEach((node, index) => {
  node.classList.add('reveal-frame');
  node.style.setProperty('--reveal-delay', `${Math.min(index % 4, 3) * 70}ms`);
});

if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
  revealNodes.forEach((node) => observer.observe(node));
} else {
  revealNodes.forEach((node) => node.classList.add('is-visible'));
}

const tiltCard = document.querySelector('.hero-visual');
if (tiltCard && window.matchMedia('(pointer: fine)').matches && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  tiltCard.addEventListener('pointermove', (event) => {
    const bounds = tiltCard.getBoundingClientRect();
    const rx = ((event.clientY - bounds.top) / bounds.height - .5) * -3;
    const ry = ((event.clientX - bounds.left) / bounds.width - .5) * 4;
    tiltCard.style.transform = `perspective(1200px) rotateX(${rx}deg) rotateY(${ry}deg)`;
  });
  tiltCard.addEventListener('pointerleave', () => {
    tiltCard.style.transform = '';
  });
}

document.querySelectorAll('a[href]').forEach((link) => {
  link.addEventListener('click', (event) => {
    const url = new URL(link.href, window.location.href);
    if (
      event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey
      || link.target === '_blank' || url.protocol !== window.location.protocol
      || url.origin !== window.location.origin || url.hash
    ) return;
    event.preventDefault();
    document.body.classList.add('page-leaving');
    window.setTimeout(() => { window.location.href = url.href; }, 170);
  });
});

const quoteLab = document.getElementById('quote-lab');
if (quoteLab) {
  const inputs = {
    distance: document.getElementById('quote-distance'),
    weight: document.getElementById('quote-weight'),
    liquid: document.getElementById('quote-liquid'),
    basket: document.getElementById('quote-basket'),
  };
  const money = (value) => `£${value.toFixed(2)}`;
  const updateQuote = () => {
    const distance = Number(inputs.distance.value);
    const weight = Number(inputs.weight.value);
    const liquid = Math.min(Number(inputs.liquid.value), weight);
    if (Number(inputs.liquid.value) !== liquid) inputs.liquid.value = liquid;
    const basket = Number(inputs.basket.value);
    const aircraft = Math.max(1, Math.ceil(weight / 1.8));
    const fees = {
      base: 2.5,
      distance: distance * 1.2,
      weight: Math.max(0, weight - .75) * .9,
      liquid: liquid * .35,
      aircraft: Math.max(0, aircraft - 1) * 1.5,
      small: basket < 8 ? .75 : 0,
    };
    const total = Object.values(fees).reduce((sum, value) => sum + value, 0);
    setText('distance-output', distance.toFixed(1));
    setText('weight-output', weight.toFixed(2));
    setText('liquid-output', liquid.toFixed(2));
    setText('basket-output', basket.toFixed(2));
    setText('quote-total', money(total));
    setText('quote-base', money(fees.base));
    setText('quote-distance-fee', money(fees.distance));
    setText('quote-weight-fee', money(fees.weight));
    setText('quote-liquid-fee', money(fees.liquid));
    setText('quote-aircraft-fee', money(fees.aircraft));
    setText('quote-small-fee', money(fees.small));
    setText('quote-aircraft', `${aircraft} aircraft · ${aircraft === 1 ? 'light RPAS screening' : 'split-load requirement'}`);
    const guidance = document.getElementById('quote-guidance');
    guidance.className = 'quote-guidance';
    if (aircraft >= 3 || liquid >= 2.5 || total > basket * .65) {
      guidance.textContent = 'This basket is unlikely to be a sensible light-drone mission. Compare a cargo bike, van or collection point.';
      guidance.classList.add('stop');
    } else if (aircraft > 1 || liquid >= 1 || total > basket * .4) {
      guidance.textContent = 'This order consumes disproportionate payload capacity. Consolidation or a ground mode may be better.';
      guidance.classList.add('warn');
    } else {
      guidance.textContent = 'This order fits the intended light-delivery envelope.';
    }
  };
  Object.values(inputs).forEach((input) => input.addEventListener('input', updateQuote));
  updateQuote();
}
