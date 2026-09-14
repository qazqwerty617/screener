const fs = require('fs');
const path = require('path');

const icons = {
  'BN.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#181a20"/><g transform="translate(3.5, 3.5) scale(0.71)"><path fill="#F0B90B" d="M16.624 13.92l2.717 2.716-7.353 7.353-7.352-7.352 2.717-2.717 4.636 4.66 4.635-4.66zm4.637-4.636L24 12l-2.715 2.716L18.568 12l2.693-2.716zm-9.272 0 2.716 2.692-2.717 2.717L9.272 12l2.716-2.715zm-9.273 0L5.41 12l-2.692 2.692L0 12l2.716-2.716zM11.99.01l7.352 7.33-2.717 2.715-4.636-4.636-4.635 4.66-2.717-2.716L11.989.011z"/></g></svg>`,
  'BB.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#12151c"/><path fill="#F7A600" d="M4.5 4.5h6.5a4.5 4.5 0 0 1 3.5 7.3A5 5 0 0 1 11.5 19.5H4.5v-15zm4 3.5v3h3a1.5 1.5 0 1 0 0-3h-3zm0 6v3.5h3.5a1.75 1.75 0 1 0 0-3.5H8.5z"/><path fill="#FFFFFF" d="M15.5 10.5l4.5 4.5V4.5h-4.5v6z"/></svg>`,
  'OK.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#000000"/><rect x="4.5" y="4.5" width="4.5" height="4.5" rx="1" fill="#FFFFFF"/><rect x="15" y="4.5" width="4.5" height="4.5" rx="1" fill="#FFFFFF"/><rect x="9.75" y="9.75" width="4.5" height="4.5" rx="1" fill="#FFFFFF"/><rect x="4.5" y="15" width="4.5" height="4.5" rx="1" fill="#FFFFFF"/><rect x="15" y="15" width="4.5" height="4.5" rx="1" fill="#FFFFFF"/></svg>',
  'BG.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#00F0FF"/><path fill="#0D0F14" d="M6.5 16.5l4.5-4.5-4.5-4.5h3.5l4.5 4.5-4.5 4.5h-3.5zm6.5 0l4.5-4.5-4.5-4.5h3.5l4.5 4.5-4.5 4.5h-3.5z"/></svg>',
  'GT.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#0D0F14"/><path fill="#10B981" d="M4 12a8 8 0 0 1 14.5-4.5l-2.5 2.5A4.5 4.5 0 1 0 16.5 12h-4.5v3h7.5A8 8 0 0 1 4 12z"/></svg>',
  'MX.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#1665FF"/><path fill="#FFFFFF" d="M4 17.5V6.5l4 4.5L12 6.5l4 4.5 4-4.5v11h-3v-6l-3 3.5-2-2.3-2 2.3-3-3.5v6H4z"/></svg>',
  'KC.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#0A192F"/><path fill="#24AE8F" d="M4.5 4.5h3.5v6.5L14 4.5h4.5l-6.5 7.5L19 19.5h-4.5l-4.2-5.5v5.5H4.5v-15z"/></svg>',
  'BX.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#2B66FF"/><path fill="#FFFFFF" d="M4.5 4.5h3.5l7 7-7 7H4.5l7-7-7-7zm10.5 0H19.5l-4 4-2-2 2.5-2zm0 14H19.5l-7-7 2-2 5 9z"/></svg>',
  'HX.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#0D111D"/><path fill="#3B82F6" d="M5.5 4.5v15h3.5v-5.5h6v5.5H18.5v-15H15v5.5H9V4.5H5.5z"/></svg>',
  'HL.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#0B1320"/><circle cx="12" cy="12" r="8" fill="none" stroke="#00F5A0" stroke-width="2.5"/><circle cx="12" cy="12" r="3.5" fill="#00F5A0"/></svg>',
  'AS.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#1C1917"/><path fill="#FFB800" d="M12 2.5l2.5 7 7 2.5-7 2.5-2.5 7-2.5-7-7-2.5 7-2.5z"/></svg>',
  'ALL.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="3" y="10" width="4.5" height="10" rx="1.5" fill="#26c97a"/><rect x="9.75" y="4" width="4.5" height="16" rx="1.5" fill="#f59e0b"/><rect x="16.5" y="12" width="4.5" height="8" rx="1.5" fill="#ff4560"/></svg>'
};

const imgDir = path.join(__dirname, 'public', 'img');
for (const [filename, svg] of Object.entries(icons)) {
  fs.writeFileSync(path.join(imgDir, filename), svg);
  console.log('Updated:', filename);
}
