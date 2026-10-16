import { useEffect, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import type { Extension } from '@codemirror/state';
import type { WorkspaceFile } from '../types';

async function languageExtension(name: string): Promise<Extension | null> {
  const extension = name.split('.').at(-1)?.toLowerCase();
  if (extension === 'html' || extension === 'svg' || extension === 'xml') return (await import('@codemirror/lang-html')).html();
  if (extension === 'css' || extension === 'scss') return (await import('@codemirror/lang-css')).css();
  if (extension === 'js' || extension === 'jsx' || extension === 'ts' || extension === 'tsx') {
    return (await import('@codemirror/lang-javascript')).javascript({ jsx: ['jsx', 'tsx'].includes(extension), typescript: ['ts', 'tsx'].includes(extension) });
  }
  if (extension === 'json') return (await import('@codemirror/lang-json')).json();
  if (extension === 'py') return (await import('@codemirror/lang-python')).python();
  if (extension === 'md') return (await import('@codemirror/lang-markdown')).markdown();
  return null;
}

export default function CodeEditor({ file, onChange, readOnly = false }: { file: WorkspaceFile; onChange: (value: string) => void; readOnly?: boolean }) {
  const [extensions, setExtensions] = useState<Extension[]>([]);
  useEffect(() => {
    let active = true;
    void languageExtension(file.name).then((extension) => { if (active) setExtensions(extension ? [extension] : []); }).catch(() => { if (active) setExtensions([]); });
    return () => { active = false; };
  }, [file.name]);
  return <CodeMirror value={file.content} onChange={readOnly ? undefined : onChange} extensions={extensions} theme={oneDark} readOnly={readOnly} editable={!readOnly} basicSetup={{ foldGutter: false, highlightActiveLine: !readOnly, highlightActiveLineGutter: false }} height="100%" className={`flux-editor ${readOnly ? 'flux-editor-readonly' : ''}`} aria-label={`${readOnly ? 'View' : 'Edit'} ${file.name}`} />;
}
