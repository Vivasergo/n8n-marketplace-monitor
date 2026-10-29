# User guide

The bot watches saved marketplace searches and sends new items to Telegram as cards: photo, price, details and a button that opens the item. Searches and settings are shared by everyone who has access to the bot. Each recipient has to open the bot and press `/start` once, otherwise Telegram does not let the bot message them.

## Commands

| Command | What it does |
|---|---|
| `/help`, `/start` | Help with examples. Does not turn monitoring on. |
| `/list` | Searches and their IDs. |
| `/add Name URL` | Add a search (up to 15). |
| `/del ID` | Delete a search together with its history and unsent cards. |
| `/status` | Service state, interval, state of each search, queue size. |
| `/perf` | Cycle duration, delivery delay, errors, n8n CPU and memory. |
| `/history`, `/history N` | Last 24 hours or last N hours (up to 168): charts, table and events. |
| `/interval N` | Check interval, 10–360 seconds. Without a number it shows the current value. |
| `/off` | Stop checks and delivery. Data is kept and commands keep working. |
| `/on` | Start again from a clean state: only items listed after this moment are sent. |
| `/on all` | Start again and also send what was missed during the pause. |

## Adding a search

1. Set the filters on the marketplace website and copy the URL from the address bar.
2. Send `/add Sneakers https://www.marketplace.example/catalog?...`
3. The bot replies with the search ID, which is also shown in `/list`, `/status` and on every card. Delete it with `/del ID`.

The first check of a new search is silent: the bot remembers the items already listed (up to five pages) and only sends items that appear later. To change a search, delete it and add it again with the new URL.

## How checking works

- Every interval (20 seconds by default) the bot checks all enabled searches, three at a time, reading the first page sorted by newest.
- An item the bot has not seen in that search goes to the delivery queue. If an item matches two searches, two cards are sent.
- If the marketplace answers "too many requests", the bot stops the current cycle and waits one interval. Other errors affect only their own search, which is retried in the next cycle.
- Cards are sent with at least one second between messages. Failed deliveries are retried only for the recipients who did not get the card, and a card is dropped after three failed attempts.

## Reading /status and /perf

`/status` shows how many searches are in use out of 15, how many cards are waiting, how many were sent in the last 24 hours, and for each search the time of its last successful check or the reason for its last failure.

`/perf` shows the duration of the last cycle against the interval (the headroom), the average and maximum delay from finding an item to sending its card, failed executions, and CPU, memory and event-loop delay of the main n8n process.

## Reading /history

The bot stores a sample every 5 minutes for 7 days. `/history` shows aligned bar charts for cycle duration, delivery delay and CPU, an hourly table and a list of events (rate limits, errors, restarts, undelivered cards). Search IDs in events can be tapped to copy them.

## Cleanup

Every night the bot keeps about the last 500 seen items per search and removes sent cards older than 74 hours. Unsent cards are not touched. Once a week the command log is trimmed to the last 500 entries. Messages already in Telegram are not deleted.

## Troubleshooting

- Start with `/status`: errors are shown next to each search.
- One person does not get cards: check that they pressed `/start` and have not blocked the bot.
- The bot does not answer at all: the server is probably down, and `/on` will not help.
