/**
 * Page publique https://cngapp.com/avis/ : le modèle (généré par scripts/site.mjs) est complété ici avec
 * les avis publiés (relus par l'admin), lisibles par Google (note moyenne et avis dans les données structurées).
 */
import { publishedReviews } from '../api/[[route]].js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const stars = (n) => `<span class="stars" aria-label="${n} sur 5">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span>`;

export function renderReviews(html, reviews, site = 'https://cngapp.com') {
  const n = reviews.length;
  const avg = n ? reviews.reduce((a, r) => a + r.note, 0) / n : 0;
  const avgTxt = avg.toFixed(1).replace('.', ',');
  const list = n
    ? reviews.map((r) => `<figure class="card review"><div>${stars(r.note)}</div><blockquote>${esc(r.texte).replace(/\n/g, '<br>')}</blockquote><figcaption>${esc(r.nom)} · ${new Date(r.cree).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}</figcaption></figure>`).join('\n')
    : '<p class="mut">Pas encore d’avis publié. Sois le premier : Menu → Noter l’appli.</p>';
  const note = n ? `<p class="lead"><b>${avgTxt} / 5</b> ${stars(Math.round(avg))} · ${n} avis</p>` : '';
  const app = {
    '@type': 'SoftwareApplication', '@id': `${site}/#app-avis`, name: 'CNG Vinted', applicationCategory: 'FinanceApplication', operatingSystem: 'iOS, Android, Web', url: `${site}/`,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
    ...(n ? {
      aggregateRating: { '@type': 'AggregateRating', ratingValue: Number(avg.toFixed(2)), ratingCount: n, bestRating: 5, worstRating: 1 },
      review: reviews.slice(0, 20).map((r) => ({ '@type': 'Review', reviewRating: { '@type': 'Rating', ratingValue: r.note, bestRating: 5 }, author: { '@type': 'Person', name: r.nom }, reviewBody: r.texte, datePublished: String(r.cree).slice(0, 10) })),
    } : {}),
  };
  return html
    .replace('<!--NOTE-->', note)
    .replace('<!--AVIS-->', list)
    .replace(`{"@id":"${site}/#app-avis"}`, JSON.stringify(app).replace(/</g, '\\u003c'));
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  if (url.pathname !== '/avis/') return Response.redirect(`${url.origin}/avis/`, 301);
  const page = await env.ASSETS.fetch(new Request(`${url.origin}/avis/`));
  if (!page.ok) return page;
  const reviews = await publishedReviews(env).catch(() => []);
  return new Response(renderReviews(await page.text(), reviews, url.origin), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}
