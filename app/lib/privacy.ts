export const redactPII = (input: any): any => {
  if (typeof input !== 'string') return input;

  return input
    .replace(/([a-zA-Z0-9._-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/, '$1@****')
    .replace(/(\d{3})\d{4}(\d{4})/, '$1****$2')
    .replace(/(.{4}).*(.{4})/, '$1****$2');
};
