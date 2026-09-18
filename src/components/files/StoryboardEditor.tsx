import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from '../../lib/tauri-bridge';
import {
  parseStoryboardMarkdown,
  resolveStoryboardAssetPath,
  serializeStoryboardMarkdown,
  STORYBOARD_FIELDS,
  type StoryboardDocument,
  type StoryboardField,
  type StoryboardMark,
} from '../../lib/storyboard';
import { useT } from '../../lib/i18n';
import { useSessionStore } from '../../stores/sessionStore';
import { showToast } from '../shared/Toast';

interface StoryboardEditorProps {
  filePath: string;
  content: string;
  onChange: (content: string) => void;
}

const SHORT_FIELDS = new Set<StoryboardField>([
  '镜号', '时间码', '景别', '机位·角度', '镜头运动', '焦段', '构图', '光', '声音', '转场',
]);
const FULL_ROW_FIELDS: StoryboardField[] = [
  '主体·动作', '光', '色彩·风格', '声音', '转场', '画面描述',
  '提示词·中', '提示词·英', '负向提示词', '备注·自检',
];
const MARKS: { value: StoryboardMark; className: string; rowClass: string }[] = [
  { value: '', className: 'bg-bg-primary border-border-strong', rowClass: '' },
  { value: 'red', className: 'bg-red-500 border-red-500', rowClass: 'bg-red-500/10' },
  { value: 'amber', className: 'bg-amber-400 border-amber-400', rowClass: 'bg-amber-400/10' },
  { value: 'green', className: 'bg-emerald-500 border-emerald-500', rowClass: 'bg-emerald-500/10' },
  { value: 'blue', className: 'bg-blue-500 border-blue-500', rowClass: 'bg-blue-500/10' },
];

function cloneDocument(document: StoryboardDocument): StoryboardDocument {
  return structuredClone(document);
}

function imageExtension(type: string, name = ''): string {
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/webp') return 'webp';
  if (type === 'image/gif') return 'gif';
  const extension = name.split('.').pop()?.toLowerCase();
  if (extension && ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) return extension;
  return 'png';
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function StoryboardImage({ filePath, imagePath, override, onClick }: {
  filePath: string;
  imagePath: string;
  override?: string;
  onClick?: () => void;
}) {
  const [src, setSrc] = useState<string | null>(override ?? null);

  useEffect(() => {
    if (override) {
      setSrc(override);
      return;
    }
    if (!imagePath) {
      setSrc(null);
      return;
    }
    let cancelled = false;
    const grantId = useSessionStore.getState().selectedSessionId ?? 'storyboard-assets';
    const absolutePath = resolveStoryboardAssetPath(filePath, imagePath);
    bridge.addPathGrant(grantId, absolutePath)
      .catch(() => {})
      .then(() => bridge.readFileBase64(absolutePath, grantId))
      .then((value) => { if (!cancelled) setSrc(value); })
      .catch(() => { if (!cancelled) setSrc(null); });
    return () => { cancelled = true; };
  }, [filePath, imagePath, override]);

  if (!src) return <span className="flex h-full items-center justify-center text-[11px] text-text-tertiary">{imagePath ? '图片未找到' : '添加图片'}</span>;
  return <img src={src} alt="" onClick={onClick}
    className="h-full w-full cursor-pointer object-contain" draggable={false} />;
}

export function StoryboardEditor({ filePath, content, onChange }: StoryboardEditorProps) {
  const t = useT();
  const [document, setDocument] = useState<StoryboardDocument | null>(() => parseStoryboardMarkdown(content));
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [past, setPast] = useState<StoryboardDocument[]>([]);
  const [future, setFuture] = useState<StoryboardDocument[]>([]);
  const [imageOverrides, setImageOverrides] = useState<Record<string, string>>({});
  const [isWritingImage, setIsWritingImage] = useState(false);
  const [displayMode, setDisplayMode] = useState<'compact' | 'full'>('compact');
  const [pathInput, setPathInput] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [copiedField, setCopiedField] = useState<StoryboardField | null>(null);
  const editBaseline = useRef<StoryboardDocument | null>(null);

  useEffect(() => {
    const next = parseStoryboardMarkdown(content);
    setDocument(next);
    setSelectedIndex(0);
    setPast([]);
    setFuture([]);
    setImageOverrides({});
    setPathInput('');
    setCopiedField(null);
    editBaseline.current = null;
  }, [filePath]);

  const publish = useCallback((next: StoryboardDocument) => {
    setDocument(next);
    onChange(serializeStoryboardMarkdown(next));
  }, [onChange]);

  const updateField = useCallback((field: StoryboardField, value: string) => {
    if (!document) return;
    const next = cloneDocument(document);
    next.shots[selectedIndex].fields[field] = value;
    publish(next);
  }, [document, selectedIndex, publish]);

  const updateHeading = useCallback((value: string) => {
    if (!document) return;
    const next = cloneDocument(document);
    next.shots[selectedIndex].heading = value;
    publish(next);
  }, [document, selectedIndex, publish]);

  const beginEdit = useCallback(() => {
    if (document && !editBaseline.current) editBaseline.current = cloneDocument(document);
  }, [document]);

  const finishEdit = useCallback(() => {
    if (!editBaseline.current) return;
    setPast((items) => [...items, editBaseline.current!]);
    setFuture([]);
    editBaseline.current = null;
  }, []);

  const undo = useCallback(() => {
    if (!document || past.length === 0) return;
    const previous = past[past.length - 1];
    setPast((items) => items.slice(0, -1));
    setFuture((items) => [cloneDocument(document), ...items]);
    publish(cloneDocument(previous));
  }, [document, past, publish]);

  const redo = useCallback(() => {
    if (!document || future.length === 0) return;
    const next = future[0];
    setFuture((items) => items.slice(1));
    setPast((items) => [...items, cloneDocument(document)]);
    publish(cloneDocument(next));
  }, [document, future, publish]);

  const setMark = useCallback((mark: StoryboardMark) => {
    if (!document || document.shots[selectedIndex].mark === mark) return;
    setPast((items) => [...items, cloneDocument(document)]);
    setFuture([]);
    const next = cloneDocument(document);
    next.shots[selectedIndex].mark = mark;
    publish(next);
  }, [document, selectedIndex, publish]);

  const addDataUrls = useCallback(async (items: { dataUrl: string; extension: string }[]) => {
    if (!document || items.length === 0) return;
    const next = cloneDocument(document);
    const shot = next.shots[selectedIndex];
    const shotNumber = shot.fields['镜号'] || String(selectedIndex + 1);
    const startIndex = shot.images.length;
    const grantId = useSessionStore.getState().selectedSessionId ?? 'storyboard-assets';
    setIsWritingImage(true);
    try {
      for (const [offset, item] of items.entries()) {
        const number = startIndex + offset + 1;
        const fileName = number === 1 ? `镜${shotNumber}.${item.extension}` : `镜${shotNumber}-${number}.${item.extension}`;
        const relativePath = `资源图片/${fileName}`;
        const absolutePath = resolveStoryboardAssetPath(filePath, relativePath);
        await bridge.addPathGrant(grantId, absolutePath).catch(() => {});
        await bridge.writeFileBase64(absolutePath, item.dataUrl, grantId);
        shot.images.push({ alt: `镜 ${shotNumber} 成图 ${number}`, path: relativePath });
        setImageOverrides((values) => ({ ...values, [relativePath]: item.dataUrl }));
      }
      setPast((items) => [...items, cloneDocument(document)]);
      setFuture([]);
      publish(next);
      showToast(t('storyboard.imageSaved'), 'success');
    } catch (error) {
      console.error('Failed to persist storyboard image:', error);
      showToast(`${t('storyboard.imageSaveFailed')}: ${String(error)}`, 'error');
    } finally {
      setIsWritingImage(false);
    }
  }, [document, filePath, selectedIndex, publish, t]);

  const addFiles = useCallback(async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith('image/'));
    const items = await Promise.all(images.map(async (file) => ({
      dataUrl: await blobToDataUrl(file),
      extension: imageExtension(file.type, file.name),
    })));
    await addDataUrls(items);
  }, [addDataUrls]);

  const addPaths = useCallback(async (paths: string[]) => {
    const cleanPaths = paths.map((path) => path.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    if (cleanPaths.length === 0) return;
    const grantId = useSessionStore.getState().selectedSessionId ?? 'storyboard-assets';
    try {
      const items = [];
      for (const sourcePath of cleanPaths) {
        await bridge.addPathGrant(grantId, sourcePath).catch(() => {});
        items.push({
          dataUrl: await bridge.readFileBase64(sourcePath, grantId),
          extension: imageExtension('', sourcePath),
        });
      }
      await addDataUrls(items);
      setPathInput('');
    } catch (error) {
      console.error('Failed to add image paths:', error);
      showToast(`${t('storyboard.imageSaveFailed')}: ${String(error)}`, 'error');
    }
  }, [addDataUrls, t]);

  const pickImages = useCallback(async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      multiple: true,
      title: t('storyboard.chooseImages'),
      filters: [{ name: t('storyboard.image'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
    if (!selected) return;
    await addPaths(Array.isArray(selected) ? selected : [selected]);
  }, [addPaths, t]);

  const pasteImage = useCallback(async (event: React.ClipboardEvent) => {
    const images = [...event.clipboardData.items]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (images.length === 0) return;
    event.preventDefault();
    await addFiles(images);
  }, [addFiles]);

  const dropImages = useCallback(async (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
    await addFiles([...event.dataTransfer.files]);
  }, [addFiles]);

  const removeImage = useCallback((imageIndex: number) => {
    if (!document) return;
    setPast((items) => [...items, cloneDocument(document)]);
    setFuture([]);
    const next = cloneDocument(document);
    next.shots[selectedIndex].images.splice(imageIndex, 1);
    publish(next);
  }, [document, selectedIndex, publish]);

  const copyPrompt = useCallback(async (field: StoryboardField) => {
    if (!document) return;
    const value = document.shots[selectedIndex].fields[field];
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      window.setTimeout(() => setCopiedField((current) => current === field ? null : current), 1600);
    } catch (error) {
      console.error('Failed to copy storyboard prompt:', error);
      showToast(t('storyboard.copyFailed'), 'error');
    }
  }, [document, selectedIndex, t]);

  if (!document || document.shots.length === 0) return null;
  const selected = document.shots[selectedIndex];

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(360px,1.15fr)_minmax(300px,0.85fr)] bg-bg-primary"
      onPaste={pasteImage} onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)} onDrop={dropImages}>
      <div className="min-w-0 overflow-auto border-r border-border-subtle">
        <div className="sticky top-0 z-20 flex items-center justify-between border-b border-border-subtle bg-bg-primary px-2 py-1.5">
          <span className="text-[11px] text-text-muted">{document.shots.length} {t('storyboard.shots')}</span>
          <div className="flex rounded-md bg-bg-tertiary/60 p-0.5">
            {(['compact', 'full'] as const).map((mode) => (
              <button key={mode} onClick={() => setDisplayMode(mode)}
                className={`rounded px-2 py-1 text-[10px] ${displayMode === mode ? 'bg-bg-card text-accent shadow-sm' : 'text-text-muted'}`}>
                {t(`storyboard.${mode}`)}
              </button>
            ))}
          </div>
        </div>
        <table className="w-full table-fixed border-collapse text-left text-xs">
          <thead className="sticky top-[37px] z-10 bg-bg-secondary text-text-muted">
            <tr className="border-b border-border-subtle">
              <th className="w-12 px-2 py-2 font-medium">{t('storyboard.shot')}</th>
              <th className="w-24 px-2 py-2 font-medium">{t('storyboard.image')}</th>
              <th className="w-28 px-2 py-2 font-medium">{t('storyboard.timecode')}</th>
              <th className="w-24 px-2 py-2 font-medium">{t('storyboard.shotSize')}</th>
              <th className="px-2 py-2 font-medium">{displayMode === 'compact' ? t('storyboard.description') : t('storyboard.fullContent')}</th>
            </tr>
          </thead>
          <tbody>
            {document.shots.map((shot, index) => (
              <tr key={`${shot.fields['镜号']}-${index}`} onClick={() => setSelectedIndex(index)}
                className={`cursor-pointer border-b border-border-subtle align-middle transition-colors
                  ${index === selectedIndex ? 'outline outline-1 -outline-offset-1 outline-accent/50' : 'hover:bg-bg-secondary/70'}
                  ${MARKS.find((mark) => mark.value === shot.mark)?.rowClass ?? ''}`}>
                <td className="px-2 py-2 font-semibold text-text-primary">{shot.fields['镜号']}</td>
                <td className="p-1.5">
                  <div className="grid aspect-video grid-cols-2 overflow-hidden rounded border border-border-subtle bg-bg-secondary">
                    {shot.images.slice(0, 4).map((image) => (
                      <StoryboardImage key={image.path} filePath={filePath} imagePath={image.path}
                        override={imageOverrides[image.path]}
                        onClick={() => bridge.openWithDefaultApp(resolveStoryboardAssetPath(filePath, image.path))} />
                    ))}
                    {shot.images.length === 0 && <StoryboardImage filePath={filePath} imagePath="" onClick={pickImages} />}
                  </div>
                </td>
                <td className="px-2 py-2 text-text-muted">{shot.fields['时间码']}</td>
                <td className="px-2 py-2 text-text-muted">{shot.fields['景别']}</td>
                <td className={`px-2 py-2 text-text-primary ${displayMode === 'compact' ? 'truncate' : 'whitespace-normal break-words align-top'}`}>
                  {displayMode === 'compact' ? shot.fields['画面描述'] : (
                    <div className="space-y-1.5 py-1">
                      {FULL_ROW_FIELDS.map((field) => shot.fields[field] && (
                        <div key={field}><span className="font-medium text-text-tertiary">{field}：</span>{shot.fields[field]}</div>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <aside className="min-w-0 overflow-y-auto bg-bg-secondary/30 p-3">
        <div className="sticky top-0 z-10 -mx-3 -mt-3 mb-3 flex items-center justify-between border-b border-border-subtle bg-bg-primary/95 px-3 py-2 backdrop-blur">
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-text-primary">{selected.heading}</div>
            <div className="text-[10px] text-text-tertiary">{t('storyboard.pasteHint')}</div>
          </div>
          <div className="flex gap-1">
            <button onClick={undo} disabled={past.length === 0} title={t('storyboard.undo')}
              className="h-7 w-7 rounded border border-border-subtle text-text-muted hover:bg-bg-tertiary disabled:opacity-30">↶</button>
            <button onClick={redo} disabled={future.length === 0} title={t('storyboard.redo')}
              className="h-7 w-7 rounded border border-border-subtle text-text-muted hover:bg-bg-tertiary disabled:opacity-30">↷</button>
          </div>
        </div>

        <div className="mb-3 flex items-center gap-1.5">
          <span className="mr-1 text-[10px] font-medium text-text-tertiary">{t('storyboard.mark')}</span>
          {MARKS.map((mark) => (
            <button key={mark.value || 'none'} onClick={() => setMark(mark.value)}
              title={mark.value ? t(`storyboard.mark.${mark.value}`) : t('storyboard.mark.none')}
              className={`h-5 w-5 rounded-full border-2 ${mark.className} ${selected.mark === mark.value ? 'ring-2 ring-accent ring-offset-1 ring-offset-bg-primary' : ''}`} />
          ))}
        </div>

        <label className="mb-3 block">
          <span className="mb-1 block text-[10px] font-medium text-text-tertiary">{t('storyboard.title')}</span>
          <input value={selected.heading} onFocus={beginEdit} onBlur={finishEdit}
            onChange={(event) => updateHeading(event.target.value)}
            className="w-full rounded border border-border-subtle bg-bg-primary px-2.5 py-2 text-xs text-text-primary outline-none focus:border-accent" />
        </label>

        <div className={`mb-2 grid grid-cols-2 gap-2 rounded border border-dashed p-2 transition-colors ${isDragging ? 'border-accent bg-accent/10' : 'border-border-subtle bg-bg-primary'}`}>
          {selected.images.map((image, imageIndex) => (
            <div key={image.path} className="group relative aspect-video overflow-hidden rounded border border-border-subtle bg-bg-secondary">
              <StoryboardImage filePath={filePath} imagePath={image.path} override={imageOverrides[image.path]}
                onClick={() => bridge.openWithDefaultApp(resolveStoryboardAssetPath(filePath, image.path))} />
              <button onClick={() => removeImage(imageIndex)} title={t('storyboard.removeImage')}
                className="absolute right-1 top-1 hidden h-6 w-6 rounded bg-black/65 text-sm text-white group-hover:block">×</button>
            </div>
          ))}
          <button onClick={pickImages}
            className="flex aspect-video items-center justify-center rounded border border-dashed border-border-strong text-xs text-text-muted hover:border-accent hover:text-accent">
            + {t('storyboard.addImages')}
          </button>
        </div>
        {isWritingImage && <div className="mb-3 text-[11px] text-accent">{t('storyboard.savingImage')}</div>}

        <div className="mb-3 flex gap-1.5">
          <input value={pathInput} onChange={(event) => setPathInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') addPaths(pathInput.split(/[;\n]/)); }}
            placeholder={t('storyboard.pathPlaceholder')}
            className="min-w-0 flex-1 rounded border border-border-subtle bg-bg-primary px-2.5 py-2 text-xs text-text-primary outline-none focus:border-accent" />
          <button onClick={() => addPaths(pathInput.split(/[;\n]/))} disabled={!pathInput.trim() || isWritingImage}
            className="rounded bg-bg-tertiary px-3 text-xs text-text-primary hover:bg-accent hover:text-text-inverse disabled:opacity-40">
            {t('storyboard.import')}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {STORYBOARD_FIELDS.map((field) => (
            <label key={field} className={SHORT_FIELDS.has(field) ? 'block' : 'col-span-2 block'}>
              <span className="mb-1 flex items-center justify-between text-[10px] font-medium text-text-tertiary">
                {field}
                {(field === '提示词·中' || field === '提示词·英') && (
                  <button type="button" onClick={() => copyPrompt(field)} disabled={!selected.fields[field]}
                    className="rounded px-1.5 py-0.5 text-[10px] text-text-muted hover:bg-bg-tertiary hover:text-accent disabled:opacity-30">
                    {copiedField === field ? t('storyboard.copied') : t('storyboard.copyPrompt')}
                  </button>
                )}
              </span>
              {SHORT_FIELDS.has(field) ? (
                <input value={selected.fields[field]} onFocus={beginEdit} onBlur={finishEdit}
                  onChange={(event) => updateField(field, event.target.value)}
                  className="w-full rounded border border-border-subtle bg-bg-primary px-2.5 py-2 text-xs text-text-primary outline-none focus:border-accent" />
              ) : (
                <textarea value={selected.fields[field]} onFocus={beginEdit} onBlur={finishEdit} rows={field.startsWith('提示词') ? 5 : 3}
                  onChange={(event) => updateField(field, event.target.value)}
                  className="w-full resize-y rounded border border-border-subtle bg-bg-primary px-2.5 py-2 text-xs leading-relaxed text-text-primary outline-none focus:border-accent" />
              )}
            </label>
          ))}
        </div>
      </aside>
    </div>
  );
}