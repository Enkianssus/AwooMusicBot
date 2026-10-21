import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { parseReleaseNotes, type ReleaseNotesInline } from '../release-notes-markdown';

interface ReleaseNotesProps {
    notes: string;
    /** Shown when the notes are empty or contain only stripped lines. */
    fallback: string;
    className?: string;
}

function renderInline(tokens: ReleaseNotesInline[]): ReactNode {
    return tokens.map((token, index) => token.type === 'strong'
        ? <strong key={index}>{token.text}</strong>
        : token.type === 'code'
            ? <code key={index}>{token.text}</code>
            : <Fragment key={index}>{token.text}</Fragment>);
}

/**
 * Release notes as React text (never HTML), clamped to about eight lines
 * with a toggle once they are longer.
 */
export default function ReleaseNotes({ notes, fallback, className = '' }: ReleaseNotesProps) {
    const blocks = useMemo(() => parseReleaseNotes(notes), [notes]);
    const [expanded, setExpanded] = useState(false);
    const [overflowing, setOverflowing] = useState(false);
    const contentRef = useRef<HTMLDivElement>(null);
    const contentId = useId();

    useEffect(() => {
        setExpanded(false);
    }, [notes]);

    useLayoutEffect(() => {
        const element = contentRef.current;
        if (!element || expanded) return;
        // A closed dialog has no layout yet; the observer measures again once it opens.
        const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [blocks, expanded]);

    if (blocks.length === 0) return <div className={`release-notes ${className}`}><p>{fallback}</p></div>;

    return (
        <div className={`release-notes ${className}`}>
            <div ref={contentRef} id={contentId} className={`release-notes-content${expanded ? '' : ' is-clamped'}${overflowing && !expanded ? ' is-faded' : ''}`}>
                {blocks.map((block, index) => block.type === 'heading'
                    ? block.level === 1
                        ? <h4 key={index}>{renderInline(block.content)}</h4>
                        : <h5 key={index}>{renderInline(block.content)}</h5>
                    : block.type === 'list'
                        ? <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ul>
                        : <p key={index}>{block.lines.map((line, lineIndex) => <Fragment key={lineIndex}>{lineIndex > 0 && <br />}{renderInline(line)}</Fragment>)}</p>)}
            </div>
            {(overflowing || expanded) && (
                <button type="button" className="release-notes-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>
                    {expanded ? '收起' : '展开全部'}
                </button>
            )}
        </div>
    );
}
