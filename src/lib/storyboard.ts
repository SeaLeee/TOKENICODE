export const STORYBOARD_FIELDS = [
  '镜号',
  '时间码',
  '景别',
  '机位·角度',
  '镜头运动',
  '焦段',
  '构图',
  '主体·动作',
  '光',
  '色彩·风格',
  '声音',
  '转场',
  '画面描述',
  '提示词·中',
  '提示词·英',
  '负向提示词',
  '备注·自检',
] as const;

export type StoryboardField = typeof STORYBOARD_FIELDS[number];
export type StoryboardMark = '' | 'red' | 'amber' | 'green' | 'blue';

export interface StoryboardImageRef {
  alt: string;
  path: string;
}

export interface StoryboardShot {
  heading: string;
  fields: Record<StoryboardField, string>;
  images: StoryboardImageRef[];
  mark: StoryboardMark;
}

export interface StoryboardDocument {
  preamble: string;
  shots: StoryboardShot[];
}

const SHOT_HEADING = /^###\s+镜\s*\d+[^\r\n]*$/gm;
const TABLE_ROW = /^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|\s*$/gm;
const IMAGE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const MARK = /<!--\s*tokenicode-storyboard:mark=(red|amber|green|blue)\s*-->/;

function maskFencedCode(content: string): string {
  return content.replace(/^(```|~~~)[^\r\n]*\r?\n[\s\S]*?^\1\s*$/gm, (block) =>
    block.replace(/[^\r\n]/g, ' '));
}

function emptyFields(): Record<StoryboardField, string> {
  return Object.fromEntries(STORYBOARD_FIELDS.map((field) => [field, ''])) as Record<StoryboardField, string>;
}

function unescapeCell(value: string): string {
  return value.replace(/<br\s*\/?>/gi, '\n').replace(/\\\|/g, '|').trim();
}

function escapeCell(value: string): string {
  return value.trim().replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|');
}

export function isStoryboardMarkdown(content: string): boolean {
  const visibleContent = maskFencedCode(content);
  return /^###\s+镜\s*\d+/m.test(visibleContent)
    && /^\|\s*镜号\s*\|/m.test(visibleContent)
    && /^\|\s*时间码\s*\|/m.test(visibleContent);
}

export function parseStoryboardMarkdown(content: string): StoryboardDocument | null {
  const headings = [...maskFencedCode(content).matchAll(SHOT_HEADING)];
  if (headings.length === 0 || !isStoryboardMarkdown(content)) return null;

  const shots = headings.map((match, index) => {
    const start = match.index!;
    const end = headings[index + 1]?.index ?? content.length;
    const block = content.slice(start, end);
    const fields = emptyFields();

    for (const row of block.matchAll(TABLE_ROW)) {
      const field = row[1].trim() as StoryboardField;
      if (STORYBOARD_FIELDS.includes(field)) fields[field] = unescapeCell(row[2]);
    }

    const images = [...block.matchAll(IMAGE)].map((image) => ({
      alt: image[1],
      path: image[2].trim(),
    }));
    const mark = block.match(MARK)?.[1] as StoryboardMark | undefined;
    return {
      heading: match[0].replace(/^###\s+/, '').trim(),
      fields,
      images,
      mark: mark ?? '',
    };
  });

  return {
    preamble: content.slice(0, headings[0].index).trimEnd(),
    shots,
  };
}

export function serializeStoryboardMarkdown(document: StoryboardDocument): string {
  const blocks = document.shots.map((shot) => {
    const rows = STORYBOARD_FIELDS
      .map((field) => `| ${field} | ${escapeCell(shot.fields[field])} |`)
      .join('\n');
    const images = shot.images
      .map((image, index) => `![${image.alt || `镜 ${shot.fields['镜号']} 成图 ${index + 1}`}](${image.path})`)
      .join('\n\n');
    const mark = shot.mark ? `\n\n<!-- tokenicode-storyboard:mark=${shot.mark} -->` : '';

    return `### ${shot.heading}\n\n| 要素 | 内容 |\n|---|---|\n${rows}\n\n**成图**：\n\n${images}${mark}`.trimEnd();
  });

  const prefix = document.preamble ? `${document.preamble}\n\n` : '';
  return `${prefix}${blocks.join('\n\n---\n\n')}\n`;
}

export function resolveStoryboardAssetPath(markdownPath: string, imagePath: string): string {
  if (/^[A-Za-z]:[/\\]/.test(imagePath) || imagePath.startsWith('/')) return imagePath;
  const normalized = markdownPath.replace(/\\/g, '/');
  const directory = normalized.slice(0, normalized.lastIndexOf('/'));
  const parts = `${directory}/${imagePath}`.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') resolved.pop();
    else if (part !== '.') resolved.push(part);
  }
  return resolved.join('/');
}