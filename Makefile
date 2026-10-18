test:
	cd /home/pepl/projects/bro--bro-0d7on/packages/cli && ls node_modules/.bin/tsx 2>/dev/null || npm install --silent --no-audit --no-fund 2>&1 | tail -3; npx tsx --test src/session-planes/devin.test.ts src/agent-connectors.test.ts 2>&1 | tail -12
