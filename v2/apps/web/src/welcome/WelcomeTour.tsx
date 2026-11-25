import { BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { Icon } from "../ui/Icon.js";

/**
 * The buddies, in four tiles: the starter team (Primary, Builder, Tester) and how the person works with
 * them. Each tile is a small drawing of the real surface it names, with the same avatars the app uses.
 */
export function WelcomeTour() {
  const tiles = [
    {
      caption: "Tell Primary what you want. It plans the work and hands out the parts.",
      art: <PrimaryArt />,
    },
    {
      caption: "Builder builds features and fixes bugs, each job in its own worktree.",
      art: <BuilderArt />,
    },
    {
      caption: "Tester checks every Builder job before it reaches you.",
      art: <TesterArt />,
    },
    {
      caption: "Waiting on you collects what needs an answer. Merge right from the result.",
      art: <WaitingArt />,
    },
  ];
  return (
    <>
      <header className="welcome-head">
        <h1 className="welcome-title">
          Meet your buddies. <span className="welcome-title-dim">A team that keeps work moving.</span>
        </h1>
        <p className="welcome-lede">
          Buddies are agents with a job each. Find them under Buddies in the sidebar, or type <kbd>@Builder</kbd> in any
          chat.
        </p>
      </header>
      <ul className="welcome-tour" aria-label="Your buddies">
        {tiles.map((tile, index) => (
          <li key={tile.caption} className="welcome-feature" style={{ animationDelay: `${index * 60}ms` }}>
            <div className="feature-art" aria-hidden="true">
              {tile.art}
            </div>
            <p className="feature-caption">{tile.caption}</p>
          </li>
        ))}
      </ul>
    </>
  );
}

function PrimaryArt() {
  return (
    <div className="art-chat">
      <span className="art-bubble">Make the progress bar thinner</span>
      <span className="art-reply">
        <BuddyAvatar buddy="sky" look="blob" size={18} mood="done" />
        <span>Builder has it. Tester checks it after.</span>
      </span>
    </div>
  );
}

function BuilderArt() {
  return (
    <div className="art-stack">
      <div className="art-row is-lit">
        <BuddyAvatar buddy="tangerine" look="bot" size={16} mood="working" />
        <span className="art-row-title">Progress bar polish</span>
        <span className="art-state is-work">
          <span className="spinner art-spinner" />
          Working
        </span>
      </div>
      <div className="art-row">
        <Icon name="branch" size={13} />
        <span className="art-row-title is-mono">builder/progress-bar</span>
        <span className="art-meta is-mono">
          <span className="art-plus">+18</span> <span className="art-minus">−7</span>
        </span>
      </div>
      <div className="art-row">
        <Icon name="file" size={13} />
        <span className="art-row-title is-mono">ProgressBar.tsx</span>
        <span className="art-meta">edited</span>
      </div>
    </div>
  );
}

function TesterArt() {
  const checks = [
    { name: "Unit tests", state: "42 passed" },
    { name: "Type check", state: "Clean" },
    { name: "Lint", state: "Clean" },
  ];
  return (
    <div className="art-stack">
      <div className="art-row">
        <BuddyAvatar buddy="jade" look="critter" size={16} mood="thinking" />
        <span className="art-row-title">Tester on Progress bar polish</span>
      </div>
      {checks.map((check) => (
        <div key={check.name} className="art-row">
          <span className="art-check">
            <Icon name="check" size={11} />
          </span>
          <span className="art-row-title">{check.name}</span>
          <span className="art-meta">{check.state}</span>
        </div>
      ))}
    </div>
  );
}

function WaitingArt() {
  return (
    <div className="art-card">
      <span className="art-card-head">Waiting on you</span>
      <div className="art-row">
        <BuddyAvatar buddy="tangerine" look="bot" size={16} mood="waiting" />
        <span className="art-row-copy">
          <span className="art-row-title">Retry uploads</span>
          <span className="art-meta">Retry three times, or five?</span>
        </span>
      </div>
      <div className="art-row">
        <BuddyAvatar buddy="sky" look="blob" size={16} mood="done" />
        <span className="art-row-copy">
          <span className="art-row-title">Progress bar polish</span>
          <span className="art-meta">Checks pass. Ready to merge.</span>
        </span>
        <span className="art-button is-merge">Merge</span>
      </div>
    </div>
  );
}
