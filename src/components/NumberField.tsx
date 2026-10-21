import { useEffect, useId, useRef, useState } from 'react';
import { parseNumberDraft, type NumberDraftResult } from '../number-field-policy';

interface NumberFieldProps {
    /** The last committed value; the field edits a draft of it. */
    value: number;
    onCommit: (value: number) => void;
    min?: number;
    max?: number;
    integer?: boolean;
    /** Replaces the range check, e.g. for ports that must not collide. */
    parse?: (draft: string) => NumberDraftResult;
    id?: string;
    ariaLabel?: string;
    disabled?: boolean;
    placeholder?: string;
    className?: string;
    wrapperClassName?: string;
}

/**
 * Keeps the typed text as a draft and commits on blur or Enter only when it
 * is valid. An invalid draft shows an inline error while the setting keeps its
 * last committed value; Escape restores that value.
 */
export default function NumberField({
    value,
    onCommit,
    min,
    max,
    integer = false,
    parse,
    id,
    ariaLabel,
    disabled,
    placeholder,
    className = '',
    wrapperClassName = ''
}: NumberFieldProps) {
    const committedText = Number.isFinite(value) ? String(value) : '';
    const [draft, setDraft] = useState(committedText);
    const [error, setError] = useState('');
    const editingRef = useRef(false);
    const errorId = useId();

    // Follow changes made elsewhere (poll, reset button, slider) unless the field is being edited.
    useEffect(() => {
        if (editingRef.current) return;
        setDraft(committedText);
        setError('');
    }, [committedText]);

    const validate = (text: string) => parse ? parse(text) : parseNumberDraft(text, { min, max, integer });

    const commit = (text: string) => {
        if (text === committedText) {
            setError('');
            return;
        }
        const result = validate(text);
        if (!result.ok) {
            setError(result.error);
            return;
        }
        setError('');
        setDraft(String(result.value));
        if (result.value !== value) onCommit(result.value);
    };

    return (
        <span className={`flex flex-col ${wrapperClassName}`}>
            <input
                id={id}
                type="text"
                inputMode={integer ? 'numeric' : 'decimal'}
                autoComplete="off"
                aria-label={ariaLabel}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                disabled={disabled}
                placeholder={placeholder}
                value={draft}
                onFocus={() => { editingRef.current = true; }}
                onChange={event => {
                    const next = event.target.value;
                    setDraft(next);
                    if (error) {
                        const result = validate(next);
                        setError(result.ok ? '' : result.error);
                    }
                }}
                onBlur={event => {
                    editingRef.current = false;
                    // The DOM value, not the last rendered draft: blur can follow a keystroke before re-render.
                    commit(event.currentTarget.value);
                }}
                onKeyDown={event => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        commit(event.currentTarget.value);
                    } else if (event.key === 'Escape') {
                        event.preventDefault();
                        setDraft(committedText);
                        setError('');
                    }
                }}
                className={className}
                style={error ? { borderColor: 'var(--studio-danger, #ef4444)' } : undefined}
            />
            {error && <span id={errorId} role="alert" className="mt-1 text-[10px] leading-snug text-red-300">{error}</span>}
        </span>
    );
}
