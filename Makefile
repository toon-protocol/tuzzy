# tuzzy. See README.md.
.PHONY: install test buy take status sandbox-e2e

## install dependencies
install:
	npm install

## every decision tuzzy makes for itself — no chain, no containers, nothing on disk
test:
	npm test

## decide whether to buy, and if so buy once. This is the timer's command.
buy:
	node src/tuzzy.ts buy

## hand out one credential, marked spent before it leaves
take:
	node src/tuzzy.ts take

## what is held, and whether a purchase is due
status:
	node src/tuzzy.ts status

## the one integration gate: a real purchase across a real denomination
## boundary. Needs a sibling `infra` checkout running the credentials profile:
##     cd ../infra/sandbox && make up-credentials
## Exits 78 if the sandbox is not there — that is the sandbox missing, not tuzzy
## failing, and the two must not be one exit code.
sandbox-e2e:
	node scripts/sandbox-e2e.ts
