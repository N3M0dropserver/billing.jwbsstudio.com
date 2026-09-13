/**
 * Businesses to tune the lead filter against.
 *
 * Four searches, chosen because each one breaks the pipeline differently:
 *
 *   napier-cafe     — hospitality, where chains and branches are the danger
 *   hamilton-plumber— trades, where the good prospects have the worst sites
 *   geelong-physio  — clinics, where a competent site is not an opportunity
 *   nelson-jeweller — retail, where scale hides behind one shopfront
 *
 * Every fixture carries `want`, which is the judgement a person would make
 * looking at the business for thirty seconds. The bench is right when the
 * pipeline agrees with that, and every disagreement is either a bug in the
 * scoring or a wrong `want` — both worth arguing about out loud.
 *
 * The HTML is written to carry the signals the real crawler would find, not
 * to look like a real page.
 */

import type { Scenario } from './harness';

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

const words = (n: number) => 'We have been roasting and serving here for a while now. '.repeat(n);

/** A site built by the owner in about 2009 and never touched since. */
const NEGLECTED = `<html><head><title>Home</title></head>
<body bgcolor="#f5f0e0"><center><font size="4">Welcome to our website</font></center>
<table cellpadding="4"><tr><td>We are open six days.</td></tr></table>
<p>Phone us on 06 835 1234.</p>
<footer>Copyright 2014</footer></body></html>`;

/** A one-page Wix site: modern enough to load, thin enough to be a problem. */
const THIN_WIX = `<!doctype html><html><head><title>Home</title>
<script src="https://static.wixstatic.com/services/wix-thunderbolt/dist/main.js"></script>
</head><body><h1>Kai &amp; Co</h1>
<p>Open Wednesday to Sunday.</p>
<a href="https://facebook.com/kaiandco">Facebook</a>
</body></html>`;

/** Trading properly, but the site was never built for a phone. */
const NO_VIEWPORT = `<!doctype html><html><head><title>Hutchings Plumbing — Hamilton</title>
<meta name="description" content="Plumbing and drainlaying in Hamilton since 1998." />
</head><body><h1>Hutchings Plumbing</h1>
<p>${words(20)}</p>
<img src="/van.jpg" alt="Our van" />
<a href="mailto:office@hutchingsplumbing.test">Email us</a>
<footer>© 2019 Hutchings Plumbing</footer></body></html>`;

/** Nothing measurably wrong. There is no honest case to make here. */
const GOOD = `<!doctype html><html lang="en"><head>
<title>Bell &amp; Bray — physiotherapy in Geelong</title>
<meta name="description" content="Musculoskeletal physiotherapy in central Geelong." />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="/favicon.svg" /></head>
<body><h1>Bell &amp; Bray Physiotherapy</h1>
<p>${words(30)}</p>
<img src="/clinic.jpg" alt="The clinic" />
<form action="/book"><input name="name" /></form>
<a href="mailto:hello@bellbray.test">hello@bellbray.test</a>
<a href="https://instagram.com/bellbray">Instagram</a>
<footer>© 2026 Bell &amp; Bray</footer></body></html>`;

/** Good site, and somebody is already paid to keep it that way. */
const AGENCY_KEPT = `<!doctype html><html lang="en"><head>
<title>Ruru Jewellery — handmade in Nelson</title>
<meta name="description" content="Handmade jewellery, Nelson." />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="/favicon.svg" />
<script src="/_next/static/chunks/main.js"></script></head>
<body><h1>Ruru Jewellery</h1><p>${words(30)}</p>
<img src="/ring.jpg" alt="A ring" />
<a href="mailto:studio@ruru.test">studio@ruru.test</a>
<footer>© 2026 Ruru Jewellery. Site designed by Kowhai Studio.</footer>
</body></html>`;

/** An operation with departments, behind one name. */
const ESTABLISHED = `<!doctype html><html lang="en"><head>
<title>Fernvale Group</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="/favicon.ico" /></head>
<body><nav>
<a href="/about">About</a><a href="/careers">Careers</a><a href="/press">Press</a>
<a href="/wholesale">Wholesale</a><a href="/our-stores">Our stores</a>
<a href="/gift-cards">Gift cards</a><a href="/sustainability">Sustainability</a>
</nav>
<h1>Fernvale</h1>
<p>Visit any of our stores nationwide. Our team of 60 people start early.</p>
<p>${words(25)}</p>
<img src="/shop.jpg" alt="A shop" />
<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>
<a href="mailto:hello@fernvale.test">hello@fernvale.test</a>
<footer>© 2026 Fernvale Group</footer></body></html>`;

/** A franchise branch: someone else owns the brand and the marketing. */
const FRANCHISE = `<!doctype html><html lang="en"><head>
<title>Laser Plumbing Hamilton</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="/favicon.ico" /></head>
<body><h1>Laser Plumbing Hamilton</h1>
<p>${words(25)}</p>
<a href="/franchise-opportunities">Franchise opportunities</a>
<a href="/locations">Find a store</a>
<img src="/team.jpg" alt="The team" />
<a href="mailto:hamilton@laserplumbing.test">hamilton@laserplumbing.test</a>
<footer>© 2026</footer></body></html>`;

/** The domain was bought and then nothing happened. */
const PARKED = `<!doctype html><html><head><title>Coming soon</title></head>
<body><h1>Coming soon</h1><p>Our website is being built.</p></body></html>`;

/* ------------------------------------------------------------------ */
/* Searches                                                            */
/* ------------------------------------------------------------------ */

export const SCENARIOS: Scenario[] = [
  {
    id: 'napier-cafe',
    niche: 'cafe',
    region: 'Napier',
    country: 'NZ',
    idealClient: 'An owner-operated cafe that does good food and looks invisible online.',
    targetCount: 3,
    scoreFloor: 55,
    scaleCeiling: 60,
    businesses: [
      {
        name: 'Kai & Co',
        want: 'lead',
        why: 'One shop, one owner, a Wix page with four sentences on it.',
        osm: { website: 'https://kaiandco.test/', email: 'kai@kaiandco.test', reviewCount: 140, context: 'amenity=cafe; has published hours' },
        html: THIN_WIX,
        model: { fit: 78, angle: 'Give the food the page it deserves and make booking a table one tap.' },
      },
      {
        name: 'Ahuriri Larder',
        want: 'lead',
        why: 'Trading well, site is a 2014 table layout with a dead copyright.',
        osm: { website: 'https://ahuririlarder.test/', email: 'hello@ahuririlarder.test', reviewCount: 320 },
        html: NEGLECTED,
        model: { fit: 72, angle: 'Bring the shopfront online — the site still says 2014.' },
      },
      {
        name: 'Wharenui Coffee House',
        want: 'lead',
        why: 'No website at all, but a real business with a map pin and an email.',
        osm: { mapsUrl: 'https://www.openstreetmap.org/node/1', email: 'wharenui@coffee.test', reviewCount: 95 },
        html: null,
        model: { fit: 70, angle: 'They have no site at all; a single page would do most of the work.' },
      },
      {
        name: "Hawke's Bay Roasting Co",
        want: 'reject',
        why: 'Four branches in the region alone. This is a group with a marketing budget.',
        osm: { website: 'https://hbroasting.test/', branchCount: 4, reviewCount: 900, brand: "Hawke's Bay Roasting Co" },
        html: ESTABLISHED,
        model: { fit: 65, tooBig: true },
      },
      {
        name: 'Fernvale',
        want: 'reject',
        why: 'Careers, press, wholesale, a store locator and Klaviyo. Somebody does this for a living.',
        osm: { website: 'https://fernvale.test/', reviewCount: 400 },
        html: ESTABLISHED,
        model: { fit: 60 },
      },
      {
        name: 'Starbucks',
        want: 'reject',
        why: 'A catalogued chain. There is no version of this that is a good idea.',
        osm: { website: 'https://starbucks.test/', brand: 'Starbucks', brandWikidata: 'Q37158', branchCount: 2, reviewCount: 1200 },
        html: ESTABLISHED,
        model: { fit: 80 },
      },
      {
        name: 'Bluff Hill Espresso',
        want: 'reject',
        why: 'Their site is fine. There is nothing honest to open an email with.',
        osm: { website: 'https://bluffhill.test/', email: 'hi@bluffhill.test', reviewCount: 210 },
        html: GOOD,
        model: { fit: 45, skip: true },
      },
    ],
  },

  {
    id: 'hamilton-plumber',
    niche: 'plumber',
    region: 'Hamilton',
    country: 'NZ',
    idealClient: 'An owner-operator tradesman who gets work by word of mouth and has no site worth the name.',
    targetCount: 3,
    scoreFloor: 55,
    scaleCeiling: 60,
    businesses: [
      {
        name: 'Hutchings Plumbing',
        want: 'lead',
        why: 'Real business, proper copy, but the site was never built for a phone.',
        osm: { website: 'https://hutchingsplumbing.test/', email: 'office@hutchingsplumbing.test', reviewCount: 60 },
        html: NO_VIEWPORT,
        model: { fit: 74, angle: 'Half their customers are on a phone and the site does not fit one.' },
      },
      {
        name: 'Te Rapa Drainage',
        want: 'lead',
        why: 'The domain shows a placeholder. They are paying for a name that does nothing.',
        osm: { website: 'https://terapadrainage.test/', email: 'jobs@terapadrainage.test', reviewCount: 24 },
        html: PARKED,
        model: { fit: 68, angle: 'The domain they hand out shows a coming-soon page.' },
      },
      {
        name: 'Kirikiriroa Gasfitting',
        want: 'lead',
        why: 'Site is dead. A domain on a van that does not load costs more than none.',
        osm: { website: 'https://kirikiriroagas.test/', email: 'mark@kirikiriroagas.test', reviewCount: 18 },
        html: null,
        reachable: false,
        model: { fit: 66, angle: 'The address on the van does not load.' },
      },
      {
        name: 'Laser Plumbing Hamilton',
        want: 'reject',
        why: 'A franchise branch. The brand and the marketing are decided somewhere else.',
        osm: { website: 'https://laserplumbing.test/', operator: 'Laser Group', branchCount: 2, reviewCount: 150 },
        html: FRANCHISE,
        model: { fit: 55, tooBig: true },
      },
      {
        name: 'Waikato Commercial Plumbing',
        want: 'reject',
        why: 'Sixty staff, a careers page and a wholesale arm. Not a cold-email business.',
        osm: { website: 'https://waikatocommercial.test/', reviewCount: 80 },
        html: ESTABLISHED,
        model: { fit: 50 },
      },
      {
        name: 'Frankton Plumbing & Gas',
        want: 'reject',
        why: 'No website and no email anywhere. Nothing to send and nowhere to send it.',
        osm: { mapsUrl: 'https://www.openstreetmap.org/node/2', reviewCount: 6 },
        html: null,
        model: { fit: 40, skip: true },
      },
    ],
  },

  {
    id: 'geelong-physio',
    niche: 'physiotherapist',
    region: 'Geelong',
    country: 'AU',
    idealClient: 'A single-site clinic where the practitioner is the owner.',
    targetCount: 2,
    scoreFloor: 55,
    scaleCeiling: 60,
    businesses: [
      {
        name: 'Pakington Physio',
        want: 'lead',
        why: 'One clinic, one owner, a site with nothing on it and no way to book.',
        osm: { website: 'https://pakingtonphysio.test/', email: 'book@pakingtonphysio.test', reviewCount: 70 },
        html: THIN_WIX,
        model: { fit: 76, angle: 'Let people book without ringing during clinic hours.' },
      },
      {
        name: 'Barwon Sports Medicine',
        want: 'reject',
        why: 'Five clinics and a careers page. They have a marketing manager.',
        osm: { website: 'https://barwonsports.test/', branchCount: 5, reviewCount: 600 },
        html: ESTABLISHED,
        model: { fit: 58, tooBig: true },
      },
      {
        name: 'Bell & Bray Physiotherapy',
        want: 'reject',
        why: 'Their site is good. Writing to them means inventing a problem.',
        osm: { website: 'https://bellbray.test/', email: 'hello@bellbray.test', reviewCount: 130 },
        html: GOOD,
        model: { fit: 40, skip: true },
      },
      {
        name: 'Corio Rehab',
        want: 'lead',
        why: 'Neglected site, one location, plainly still trading.',
        osm: { website: 'https://coriorehab.test/', email: 'admin@coriorehab.test', reviewCount: 45 },
        html: NEGLECTED,
        model: { fit: 71, angle: 'The site still lists 2014 hours; make it say what they actually do now.' },
      },
    ],
  },

  {
    id: 'nelson-jeweller',
    niche: 'jeweller',
    region: 'Nelson',
    country: 'NZ',
    idealClient: 'A maker who sells their own work from one shop.',
    targetCount: 2,
    scoreFloor: 55,
    scaleCeiling: 60,
    businesses: [
      {
        name: 'Ruru Jewellery',
        want: 'reject',
        why: 'One shop, but an agency already has this work and the site shows it.',
        osm: { website: 'https://ruru.test/', email: 'studio@ruru.test', reviewCount: 110 },
        html: AGENCY_KEPT,
        model: { fit: 62 },
      },
      {
        name: 'Maitai Goldsmiths',
        want: 'lead',
        why: 'A maker with a 2013 site and no photography of their own work.',
        osm: { website: 'https://maitaigold.test/', email: 'bench@maitaigold.test', reviewCount: 55 },
        html: NEGLECTED,
        model: { fit: 75, angle: 'Their work is the whole pitch and none of it is on the site.' },
      },
      {
        name: 'Michael Hill',
        want: 'reject',
        why: 'A listed retail chain. Catalogued, and the local store decides nothing.',
        osm: { website: 'https://michaelhill.test/', brand: 'Michael Hill', brandWikidata: 'Q6831229', branchCount: 1, reviewCount: 300 },
        html: GOOD,
        model: { fit: 70 },
      },
      {
        name: 'Tahunanui Trading',
        want: 'reject',
        why: 'Looks small, but the lookup finds a catalogued entity behind the name.',
        osm: { website: 'https://tahunanui.test/', email: 'shop@tahunanui.test', reviewCount: 200 },
        html: THIN_WIX,
        wikidata: { id: 'Q123456', description: 'New Zealand jewellery retail chain' },
        model: { fit: 68 },
      },
    ],
  },
];

export function scenarioById(id: string): Scenario {
  const found = SCENARIOS.find((scenario) => scenario.id === id);
  if (!found) throw new Error(`no scenario ${id}`);
  return found;
}
