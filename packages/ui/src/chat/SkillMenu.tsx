import { useEffect, useRef } from 'react';

export function SkillMenu({ skills, active, onPick, onHover }: {
  skills: string[];
  active: number;
  onPick: (skill: string) => void;
  onHover: (index: number) => void;
}) {
  const activeRow = useRef<HTMLLIElement>(null);
  useEffect(() => {
    activeRow.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <ul className="skill-menu" role="listbox" aria-label="Skills" data-testid="skill-menu">
      {skills.map((skill, index) => {
        const split = skill.indexOf(':');
        return (
          <li
            key={skill}
            ref={index === active ? activeRow : undefined}
            role="option"
            aria-selected={index === active}
            className={`skill-row${index === active ? ' on' : ''}`}
            onMouseMove={() => onHover(index)}
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(skill);
            }}
          >
            <span className="skill-name">/{split < 0 ? skill : skill.slice(split + 1)}</span>
            {split >= 0 && <span className="muted skill-plugin">{skill.slice(0, split)}</span>}
          </li>
        );
      })}
    </ul>
  );
}

export function SkillMenuEmpty({ loading }: { loading: boolean }) {
  return (
    <div className="skill-menu skill-menu-empty muted" data-testid="skill-menu-empty" aria-busy={loading}>
      {loading ? 'Loading skills…' : 'Skills appear once the agent has started.'}
    </div>
  );
}
