// The application profile (申请资料) that the Dayjob browser fills into
// application forms. It stays in the settings on this computer; the desktop
// browser matches it to a form's fields and fills only the ones that match.
export const YES_NO = ['', 'yes', 'no'];

// Each field's longest value, or its choices.
export const APPLICANT_FIELDS = {
  firstName: 80, lastName: 80, preferredName: 80, email: 200, phone: 40,
  address: 200, city: 100, state: 100, postalCode: 20, country: 100,
  linkedin: 300, github: 300, website: 300,
  school: 160, degree: 100, major: 160, graduation: 20,
  company: 160, title: 160, yearsExperience: 10,
  workAuthorized: YES_NO, needsSponsorship: YES_NO, willingToRelocate: YES_NO,
  salary: 100, startDate: 100, heardFrom: 100, coverLetter: 5000,
};
export const LINK_FIELDS = ['linkedin', 'github', 'website'];

export const DEFAULT_APPLICANT = { ...Object.fromEntries(Object.keys(APPLICANT_FIELDS).map(key => [key, ''])), declineEeo: true };

// Contact details that a resume's text gives away, for the "read from my
// resume" button. Only fills what it is sure of; the user checks the rest.
export function contactFromResume(text) {
  const source = String(text || '');
  const found = {};
  const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(source)?.[0];
  if (email) found.email = email;
  const phone = source.match(/(?:\+|\()?\d[\d\s().-]{7,}\d/g)?.find(match => { const digits = match.replace(/\D/g, '').length; return digits >= 10 && digits <= 15; });
  if (phone) found.phone = phone.trim();
  const link = pattern => {
    const match = pattern.exec(source)?.[0];
    return match ? `https://${match.replace(/^https?:\/\//i, '').replace(/\/$/, '')}` : null;
  };
  const linkedin = link(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[\w%-]+\/?/i);
  if (linkedin) found.linkedin = linkedin;
  const github = link(/(?:https?:\/\/)?(?:www\.)?github\.com\/[\w-]+/i);
  if (github) found.github = github;
  // The name is usually the first line: two to four words, or a Chinese name.
  const first = source.split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
  if (/^[\p{Script=Han}]{2,4}$/u.test(first)) {
    found.lastName = first.slice(0, 1);
    found.firstName = first.slice(1);
  } else if (/^[\p{L}'-]+(?: [\p{L}'.-]+){1,3}$/u.test(first) && first.length <= 60) {
    const parts = first.split(' ');
    found.firstName = parts[0];
    found.lastName = parts.at(-1);
  }
  return found;
}
