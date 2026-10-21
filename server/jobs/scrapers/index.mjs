import { linkedin } from './linkedin.mjs';
import { indeed } from './indeed.mjs';
import { BRIDGE_SITES } from './jobspy-bridge.mjs';

export const BOARD_SCRAPERS = { linkedin, indeed };

export const SITES = [
  { id: 'linkedin', label: 'LinkedIn', engine: 'native' },
  { id: 'indeed', label: 'Indeed', engine: 'native' },
  { id: 'glassdoor', label: 'Glassdoor', engine: 'jobspy' },
  { id: 'zip_recruiter', label: 'ZipRecruiter', engine: 'jobspy' },
  { id: 'google', label: 'Google Jobs', engine: 'jobspy' },
];
export const SITE_IDS = SITES.map(site => site.id);
export const JOBSPY_SITES = BRIDGE_SITES;
