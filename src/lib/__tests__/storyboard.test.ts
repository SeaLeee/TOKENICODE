import { describe, expect, it } from 'vitest';
import {
  isStoryboardMarkdown,
  parseStoryboardMarkdown,
  resolveStoryboardAssetPath,
  serializeStoryboardMarkdown,
} from '../storyboard';

const markdown = `# 项目说明

保留这段前言。

### 镜 1｜开场（00:00–00:03）

| 要素 | 内容 |
|---|---|
| 镜号 | 1 |
| 时间码 | 00:00–00:03（3s） |
| 景别 | 大远景 |
| 画面描述 | 海面与花海 |

**成图**：

![镜 1 成图](生图/镜1.png)

---

### 镜 2｜近景（00:03–00:05）

| 要素 | 内容 |
|---|---|
| 镜号 | 2 |
| 时间码 | 00:03–00:05（2s） |
| 景别 | 近景 |
| 画面描述 | 人物醒来 |

**成图**：
`;

describe('storyboard markdown', () => {
  it('detects and parses generated storyboard cards', () => {
    expect(isStoryboardMarkdown(markdown)).toBe(true);
    const parsed = parseStoryboardMarkdown(markdown)!;
    expect(parsed.preamble).toContain('保留这段前言');
    expect(parsed.shots).toHaveLength(2);
    expect(parsed.shots[0].fields['景别']).toBe('大远景');
    expect(parsed.shots[0].images).toEqual([{ alt: '镜 1 成图', path: '生图/镜1.png' }]);
  });

  it('ignores storyboard templates inside fenced code blocks', () => {
    const skillTemplate = '```markdown\n### 镜 1｜模板\n\n| 镜号 | 1 |\n| 时间码 | 00:00 |\n```';
    expect(isStoryboardMarkdown(skillTemplate)).toBe(false);
    expect(parseStoryboardMarkdown(skillTemplate)).toBeNull();
  });

  it('serializes edited fields and image paths back to markdown', () => {
    const parsed = parseStoryboardMarkdown(markdown)!;
    parsed.shots[1].fields['画面描述'] = '第一行\n第二行 | 延续';
    parsed.shots[1].images = [
      { alt: '镜 2 成图 1', path: '资源图片/镜2-1.png' },
      { alt: '镜 2 成图 2', path: '资源图片/镜2-2.jpg' },
    ];
    parsed.shots[1].mark = 'red';
    const output = serializeStoryboardMarkdown(parsed);
    const reparsed = parseStoryboardMarkdown(output)!;
    expect(output).toContain('# 项目说明');
    expect(reparsed.shots[1].fields['画面描述']).toBe('第一行\n第二行 | 延续');
    expect(reparsed.shots[1].images).toHaveLength(2);
    expect(reparsed.shots[1].images[1].path).toBe('资源图片/镜2-2.jpg');
    expect(reparsed.shots[1].mark).toBe('red');
  });

  it('resolves relative image paths beside the markdown file', () => {
    expect(resolveStoryboardAssetPath('F:/project/分镜/表.md', '资源图片/镜1.png'))
      .toBe('F:/project/分镜/资源图片/镜1.png');
    expect(resolveStoryboardAssetPath('F:/project/分镜/表.md', '../生图/镜1.png'))
      .toBe('F:/project/生图/镜1.png');
  });
});