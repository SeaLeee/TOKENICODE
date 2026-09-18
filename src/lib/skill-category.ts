/**
 * Keyword-based skill categorisation.
 *
 * Local / user-authored skills carry no marketplace category, so without this
 * they all fall into "其他". This infers a granular category from a skill's
 * name + description + tags by substring-matching a curated keyword list, so
 * e.g. a storyboard / 分镜 skill lands in 影视 rather than 其他.
 */

/** Stable category ids (used as i18n keys: `skillCategory.<id>`). */
export type SkillCategoryId =
  | 'film'
  | 'writing'
  | 'coding'
  | 'design'
  | 'data'
  | 'marketing'
  | 'music'
  | 'image'
  | 'office'
  | 'business'
  | 'security'
  | 'other';

/** Ordered most-specific first — the first category with a keyword hit wins. */
const CATEGORY_KEYWORDS: { id: SkillCategoryId; keywords: string[] }[] = [
  {
    id: 'film',
    keywords: [
      'storyboard', '分镜', '影视', '短剧', '短视频', 'film', 'movie', 'cinema',
      'cinematic', 'mv', '镜头', '运镜', '导演', 'director', 'shot', '剧本',
      'screenplay', '拍摄', '数字人', '口播', 'video', '视频', '剪辑', 'trailer',
      '预告', '爆款视频', '抖音', 'douyin', '视频号', '快手', 'tiktok', '漫剧',
    ],
  },
  {
    id: 'music',
    keywords: [
      'music', '音乐', '歌词', 'lyric', '音频', 'audio', '配乐', 'bgm', '翻唱',
      '编曲', '作曲', 'song', '声音', '播客', 'podcast',
    ],
  },
  {
    id: 'image',
    keywords: [
      'image', '图像', '绘画', 'draw', 'drawing', '图片', '海报', 'poster',
      '封面', 'cover', '插画', 'illustration', 'logo', '头像', 'avatar',
      '三视图', '图生', '文生图', 'midjourney', 'stable diffusion',
    ],
  },
  {
    id: 'design',
    keywords: [
      'design', 'ui', 'ux', '设计', '界面', 'frontend', '前端', '审美',
      'aesthetic', 'css', 'tailwind', '原型', 'prototype', 'mockup', '组件',
      'component', 'landing', 'dashboard 设计', '排版', 'typography', '幻灯片',
      'slides', 'deck',
    ],
  },
  {
    id: 'coding',
    keywords: [
      'code', 'coding', '编程', '开发', 'developer', 'bug', 'refactor', '重构',
      'api', 'debug', '调试', 'program', 'godot', 'gdscript', 'shader',
      'typescript', 'python', 'java', 'rust', 'sql', '算法', 'algorithm',
      '架构', 'architecture', '代码', '脚本开发', 'devops', 'ci/cd',
    ],
  },
  {
    id: 'data',
    keywords: [
      'data analysis', '数据分析', '数据', 'analytics', '报表', 'report',
      '看板', 'dashboard', 'bi', '统计', '爬虫', 'scrape', 'crawl', '表格',
      'excel', 'spreadsheet',
    ],
  },
  {
    id: 'marketing',
    keywords: [
      '营销', 'marketing', '运营', '账号', 'seo', 'geo', 'aeo', '增长', 'growth',
      '投流', '电商', '带货', '种草', '小红书', 'xhs', '竞品', '选题', '起号',
      '涨粉', '私域', '公众号', '拆解',
    ],
  },
  {
    id: 'writing',
    keywords: [
      'write', 'writing', '写作', '文案', 'copywriting', '改写', '爆款', 'article',
      'blog', 'essay', '小说', 'novel', '润色', '摘要', 'summarize', '总结',
      '翻译', 'translate', '人物设定', '人物小传', '剧情', '故事', 'story',
    ],
  },
  {
    id: 'business',
    keywords: [
      '商业', 'business', '公司', 'company', '战略', 'strategy', '创业',
      '项目管理', 'project management', '商业计划', 'bp', 'okr', 'kpi', '一人公司',
    ],
  },
  {
    id: 'office',
    keywords: [
      '办公', '效率', '日程', '周报', '月报', 'todo', '时间管理', 'productivity',
      'meeting', '会议', '笔记', 'note', '计划', 'schedule', '待办',
    ],
  },
  {
    id: 'security',
    keywords: [
      'security', '安全', 'cve', 'vulnerability', '漏洞', 'owasp', '渗透',
      'penetration', '审计', 'audit',
    ],
  },
];

/**
 * Infer a category id from a skill's textual signals. Returns 'other' when
 * nothing matches. Matching is case-insensitive substring on the combined
 * name + description + tags haystack.
 */
export function inferSkillCategory(
  name: string,
  description: string,
  tags?: string[],
): SkillCategoryId {
  const hay = `${name} ${description} ${(tags ?? []).join(' ')}`.toLowerCase();
  for (const { id, keywords } of CATEGORY_KEYWORDS) {
    if (keywords.some((kw) => hay.includes(kw))) return id;
  }
  return 'other';
}

/** All category ids in display order (used to keep grouped sections stable). */
export const CATEGORY_ORDER: SkillCategoryId[] = [
  'film', 'writing', 'coding', 'design', 'image', 'music',
  'data', 'marketing', 'business', 'office', 'security', 'other',
];
