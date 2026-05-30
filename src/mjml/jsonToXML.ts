export interface IMjmlNode {
  tagName: string;
  attributes?: { [key: string]: string };
  children?: IMjmlNode[];
  content?: string;
}

export const jsonToXML = ({
  tagName,
  attributes,
  children,
  content,
}: IMjmlNode): string | undefined => {
  const subNode =
    children && children.length > 0
      ? children.map(jsonToXML).join('\n')
      : content || '';
  if (attributes) {
    const stringAttrs = Object.keys(attributes)
      .filter((attr) => attributes[attr] !== undefined && attributes[attr] !== null)
      .map((attr) => `${attr}="${String(attributes[attr]).replace(/"/g, '&quot;')}"`)
      .join(' ');

    return `<${tagName}${
      stringAttrs === '' ? '>' : ` ${stringAttrs}>`
    }${subNode}</${tagName}>`;
  }
};
