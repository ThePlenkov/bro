import { useState } from 'react'

const clients = [
  { name: 'Claude Code', cmd: '/plugin marketplace add ThePlenkov/bro\n/plugin install bro@bro' },
  {
    name: 'Codex',
    cmd: 'codex plugin marketplace add ThePlenkov/bro\n# then install bro from the marketplace',
  },
  { name: 'Devin', cmd: 'devin plugins install ThePlenkov/bro' },
  { name: 'OpenCode', cmd: '// opencode.json\n"plugin": ["@broject/bro"]' },
  { name: 'just the CLI', cmd: 'npx -y @broject/bro --help' },
]

export function Install() {
  const [active, setActive] = useState(0)
  const [copied, setCopied] = useState(false)
  const { cmd } = clients[active]

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd)
    } catch {
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="install">
      <div className="install-tabs" role="tablist">
        {clients.map((c, i) => (
          <button
            key={c.name}
            type="button"
            role="tab"
            aria-selected={i === active}
            className={i === active ? 'on' : ''}
            onClick={() => setActive(i)}
          >
            {c.name}
          </button>
        ))}
      </div>
      <div className="install-cmd">
        <pre>
          {cmd.split('\n').map((l) => (
            <div key={l}>
              <span className="prompt">$</span> {l}
            </div>
          ))}
        </pre>
        <button type="button" className="copy" onClick={copy} aria-label="Copy install command">
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
    </div>
  )
}
