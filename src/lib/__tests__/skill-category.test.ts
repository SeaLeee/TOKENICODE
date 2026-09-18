import { describe, it, expect } from 'vitest';
import { inferSkillCategory } from '../skill-category';

describe('inferSkillCategory', () => {
  it('routes storyboard / 分镜 skills to film', () => {
    expect(inferSkillCategory('self-ent-film-storyboard-panel', '分镜脚本与镜头语言')).toBe('film');
    expect(inferSkillCategory('lyric-mv-storyboard', 'generate an MV storyboard')).toBe('film');
    expect(inferSkillCategory('douyin-shortvideo-design', '抖音短视频 IP 设计')).toBe('film');
  });

  it('routes coding skills to coding', () => {
    expect(inferSkillCategory('godot-gdscript-patterns', 'GDScript development patterns')).toBe('coding');
    expect(inferSkillCategory('code-bug-analyzer', '代码漏洞与Bug分析')).toBe('coding');
  });

  it('routes writing / copy skills to writing', () => {
    expect(inferSkillCategory('baokuan-gaixie', '爆款文案改写')).toBe('writing');
  });

  it('routes design skills to design', () => {
    expect(inferSkillCategory('ed-atelier-design', '前端设计与原型')).toBe('design');
  });

  it('routes marketing skills to marketing', () => {
    expect(inferSkillCategory('creator-account-teardown', '账号拆解与小红书运营')).toBe('marketing');
  });

  it('falls back to other when nothing matches', () => {
    expect(inferSkillCategory('mystery', 'zzz qqq')).toBe('other');
  });
});
