type Converter = (text: string) => string;

let converterPromise: Promise<Converter> | undefined;

function getConverter(): Promise<Converter> {
  converterPromise ??= import('opencc-js/t2cn')
    .then((module) => module.default.Converter({ from: 'tw', to: 'cn' }));
  return converterPromise;
}

function normalize(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

export async function filterByBilingualSearch<T>(
  items: T[],
  query: string,
  getFields: (item: T) => Array<string | undefined>,
): Promise<T[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return items;

  const toSimplified = await getConverter();
  const normalizedQuery = normalize(toSimplified(trimmedQuery));

  return items.filter((item) => getFields(item).some((field) => {
    if (!field) return false;
    return normalize(toSimplified(field)).includes(normalizedQuery);
  }));
}