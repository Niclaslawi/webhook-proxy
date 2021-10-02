import axios from 'axios';
import bodyParser from 'body-parser';
import Express, { NextFunction, Request, Response } from 'express';
import slowDown from 'express-slow-down';

import fs from 'fs';

// [webhook id]: reset time
const ratelimits: { [id: string]: number } = {};

const app = Express();
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

app.set('trust proxy', config.trustProxy);

app.use(require('helmet')());
app.use(bodyParser.json());

// catch spammers that ignore ratelimits in a way that can cause servers to yield for long periods of time

const webhookPostRatelimit = slowDown({
    windowMs: 2000,
    delayAfter: 5,
    delayMs: 500,
    maxDelayMs: 30000,

    keyGenerator(req, res) {
        return req.params.id ?? req.ip; // use the webhook ID as a ratelimiting key, otherwise use IP
    }
});

const unknownEndpointRatelimit = slowDown({
    windowMs: 10000,
    delayAfter: 5,
    delayMs: 500,
    maxDelayMs: 30000
});

const client = axios.create({
    validateStatus: () => true
});

app.get('/', async (req, res) => {
    return res.json({
        message: 'Webhook proxy up and running.',
        github: 'https://github.com/LewisTehMinerz/webhook-proxy'
    });
});

app.post('/api/webhooks/:id/:token', webhookPostRatelimit, async (req, res) => {
    const wait = req.query.wait ?? false;
    const threadId = req.query.thread_id;

    const body = req.body;

    // if we know this webhook is already ratelimited, don't hit discord but reject the request instead
    const ratelimit = ratelimits[req.params.id];
    if (ratelimit) {
        if (ratelimit < Date.now() / 1000) {
            delete ratelimits[req.params.id];
        } else {
            console.log(`${req.params.id} hit ratelimit`);

            res.setHeader('X-RateLimit-Limit', 5);
            res.setHeader('X-RateLimit-Remaining', 0);
            res.setHeader('X-RateLimit-Reset', ratelimit);

            return res.status(429).json({
                proxy: true,
                message: 'You have been ratelimited. Please respect the standard Discord ratelimits.'
            });
        }
    }

    const response = await client.post(
        `https://discord.com/api/webhooks/${req.params.id}/${req.params.token}?wait=${wait}${
            threadId ? '&thread_id=' + threadId : ''
        }`,
        body,
        {
            headers: {
                'User-Agent': 'WebhookProxy/1.0 (https://github.com/LewisTehMinerz/webhook-proxy)',
                'Content-Type': 'application/json'
            }
        }
    );

    // process ratelimits
    if (parseInt(response.headers['x-ratelimit-remaining']) === 0) {
        ratelimits[req.params.id] = parseInt(response.headers['x-ratelimit-reset']);
    }

    // forward headers to allow clients to process ratelimits themselves
    for (const header of Object.keys(response.headers)) {
        res.setHeader(header, response.headers[header]);
    }

    res.setHeader('Via', '1.0 WebhookProxy');

    return res.status(response.status).json(response.data);
});

app.use(webhookPostRatelimit, (req, res, next) => {
    return res.status(404).json({
        proxy: true,
        message: 'Unknown endpoint.'
    });
});

app.use(unknownEndpointRatelimit, async (err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error(err);

    return res.status(500).json({
        proxy: true,
        message: 'An error occurred while processing your request.'
    });
});

app.listen(config.port, () => {
    console.log('Up and running.');
});