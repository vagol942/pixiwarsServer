import * as path from 'path';
import * as fs from 'fs';
import * as Http from 'http';
import * as express from 'express';
import * as Mongo from 'mongodb';
import * as assert from 'assert';
import * as SocketIO from 'socket.io';
import * as TwitchJS from 'twitch-js';
import * as WebSocket from 'ws';
import * as Rx from 'rxjs';

import GameDot from './GameDot';
import colors from './colors';

const app = express();
const http = Http.Server(app);
const io = SocketIO(http);

const DEFAULT_FINAL_TIME = Date.UTC(2018, 3, 1, 7);
//const FINAL_TIME = Date.UTC(2018, 2, 22, 6, 4);
// const COOLDOWN_TIME = 3*60*1000;
const COOLDOWN_TIME = 10*1000;
// We give 30 secs of extra time to account for the twitch latency.
const FINAL_TIME_STREAMING_EXTENSION = 24*1000;
const FINAL_TIME = DEFAULT_FINAL_TIME + FINAL_TIME_STREAMING_EXTENSION;
const CHANGE_PIXEL = "CHANGE_PIXEL";
const PIXEL_IS_ETERNAL = "PIXEL_IS_ETERNAL";
const PIXEL_CHANGED = "PIXEL_CHANGED";
const NO_ETERNALS = "NO_ETERNALS";
const USER_COOLDOWN = "USER_COOLDOWN";
const GAME_IS_OVER = "GAME_IS_OVER";
const width = 128;
const height = 64;


const MongoClient = Mongo.MongoClient;
const url = 'mongodb://localhost:27017';
const dbName = 'pixiWars';
let dbClient: Mongo.MongoClient;
let db: Mongo.Db;
let usersCollection: Mongo.Collection;
let gridCollection: Mongo.Collection;
let actionCollection: Mongo.Collection;
let tipsCollection: Mongo.Collection;
let eternalsCollection: Mongo.Collection;

class Action {
    playerName: string;
    dot: GameDot;
    time: number;
    
    constructor(playerName: string, dot: GameDot, time = Date.now()) {
        this.playerName = playerName;
        this.dot = dot;
        this.time = time;
    }
}

class Pixel {
    x: number;
    y: number;
    color: number;
    playerName: string;
    canChange: boolean;

    constructor(x: number, y: number, color: number, playerName: string, canChange: boolean) {
        this.x = x;
        this.y = y;
        this.color = color;
        this.playerName = playerName;
        this.canChange = canChange;
    }
}

let gameState = {
    grid : {},
    users: []
}

// Use connect method to connect to the server
MongoClient.connect(url).then((client) => {
    console.log("[MongoDB]: Connected successfully to server.");
    db = client.db(dbName);
    usersCollection = db.collection('users');
    gridCollection = db.collection('grid');
    actionCollection = db.collection('actions');
    tipsCollection = db.collection('tips');
    eternalsCollection = db.collection('eternals');
}).catch( err => "[MongoDB]: Error connecting to server.")
    .then( () => gridCollection.find({}).toArray() )
    .then( (gridData) => populateGridFromDB(gridData) )
    .then( () => {
        
    function updateGridPixel(x: number, y: number, color: number, lastPlayer: string, canChange: boolean) {
        gridCollection.updateOne(
            {x: x, y: y, canChange: true},
            { $set: { color: color, lastPlayer: lastPlayer, canChange: canChange} },
            { upsert: true})
    }
    function addAction(action: Action) {
        actionCollection.insertOne(
            { x: action.dot.x,
              y: action.dot.y,
              playerName: action.playerName,
              color: action.dot.color,
              canChange: action.dot.canChange,
              time: action.time
            })
    }

    function getPlayerEternals(username) : Promise<number>{
        return eternalsCollection.findOne({username: username})
            .then(player => player.eternals)
            .catch(err => {throw new Error("PLAYER NOT FOUND")});
    }

    // State modifier
    function gameStateModifier(action): Promise<String> {
        switch (action.message) {
            case CHANGE_PIXEL:
                if (Date.now() < FINAL_TIME) {
                    const pixel = action.data.pixel;
                    if (!playerOnCoolDown(pixel.lastPlayer)) {
                    // if (true) {
                        if (gameState.grid[`${pixel.x},${pixel.y}`] && gameState.grid[`${pixel.x},${pixel.y}`].canChange == false) {
                            return new Promise((res, rej) => PIXEL_IS_ETERNAL);
                        } else {
                            // check for eternal pixel
                            if (pixel.canChange == false) {
                                return eternalsCollection.findOne({ username: pixel.lastPlayer })
                                .catch(err => NO_ETERNALS)
                                .then(doc => {
                                    if (doc.eternals && doc.eternals >= 1) {
                                        return "OK";
                                    } else {
                                        throw new Error("NO_ETERNALS");
                                    }
                                })
                                .then(() => {
                                    // state mutation
                                    gameState.grid[`${pixel.x},${pixel.y}`] = { ...pixel };
                                    gameState.users[pixel.lastPlayer] = { lastPlay: Date.now() };
                                    // effects
                                    eternalsCollection.updateOne({ username: pixel.lastPlayer }, { $inc: {eternals: -1}});
                                    io.emit('pixelData', { pixel });
                                    updateGridPixel(pixel.x, pixel.y, pixel.color, pixel.lastPlayer, pixel.canChange);
                                    addAction(new Action(pixel.lastPlayer, new GameDot(pixel.x, pixel.y, pixel.color), Date.now()));
                                    // end effects
                                    return PIXEL_CHANGED;
                                })
                                .catch(err => NO_ETERNALS);
                            }
                            else {
                                // state mutation
                                gameState.grid[`${pixel.x},${pixel.y}`] = { ...pixel };
                                gameState.users[pixel.lastPlayer] = { lastPlay: Date.now() };
                                // effects
                                io.emit('pixelData', { pixel });
                                updateGridPixel(pixel.x, pixel.y, pixel.color, pixel.lastPlayer, pixel.canChange);
                                addAction(new Action(pixel.lastPlayer, new GameDot(pixel.x, pixel.y, pixel.color), Date.now()));
                                // end effects
                                return new Promise((res, rej) => PIXEL_CHANGED);
                            }
                        }
                    } else {
                        return new Promise((res, rej) => USER_COOLDOWN);
                    }
            } else {
                return new Promise((res, rej) => GAME_IS_OVER);
            }
        }
    }

    function playerOnCoolDown(playerName): boolean {
        if (gameState.users[playerName]) {
            if (gameState.users[playerName].lastPlay) {
                if (Date.now() - gameState.users[playerName].lastPlay <= COOLDOWN_TIME) {
                    // console.log(`TIME SINCE LAST PLAY: ${Date.now() - gameState.users[playerName].lastPlay}`)
                    return true;
                }
            }
        }
        return false;
    }

    function timeToCoolPlayer(playerName): number {
        if (gameState.users[playerName]) {
            if (gameState.users[playerName].lastPlay) {
                return Math.abs(Date.now() - gameState.users[playerName].lastPlay);
            }
        } else {
            return 0;
        }
    }

    function TestDat() {
        const pixel = {
            x: Math.floor((Math.random() * 127)),
            y: Math.floor((Math.random() * 63)), 
            color: Math.floor(Math.random()*255*255*255),
            lastPlayer: `Victor_${Date.now()}`,
            canChange: Math.random() > 0.05 ? true : false,
        }
        const action = {
            message: CHANGE_PIXEL,
            data: {
                pixel
            }
        }
        gameStateModifier(action);
    }

    // The events
    const twitchOptions = {
        options: {
            debug: false,
        },
        connection: {
            cluster: "aws",
            reconnect: true,
        },
        identity: {
            username: "pixiwarsbot",
            password: "oauth:c4oown4ywkpovokgo54hnk1re0z0ua"
        },
        channels: ["PixiWars"]
    }

    const twitchClient = TwitchJS.client(twitchOptions);
    const dotCommandRegEx = /^!pixel (\d+) (\d+) (\w+)$/
    const eternalCommandRegEx = /^!eternal (\d+) (\d+) (\w+)$/
    const colorRegex = /(^[A-Fa-f0-9]{1,6}$)/ 

    function validateMessageData(messageData) {
        const x = messageData[1];
        const y = messageData[2];
        const color = messageData[3];

        if (!(x >= 0 && x <= 127)) {
            return false;
        }
        if (!(y >= 0 && y <= 63)) {
            return false;
        }
        if (!(color in colors || colorRegex.test(color))) {
            return false;
        }
        return true;
    }

    function getDotFromMessage(messageData, playerDisplayName, canChange) {
        const x = parseInt(messageData[1]);
        const y = parseInt(messageData[2]);
        const color = messageData[3] in colors ? colors[messageData[3]] : `0x${messageData[3].match(colorRegex)[1]}`
        const lastPlayer = playerDisplayName.toLowerCase();

        return {x, y, color, canChange, lastPlayer}
    }


    const MSG_THRESHOLE_AMOUNT = 98;
    const MSG_THRESHOLE_TIME = 40;

    const messageTime = MSG_THRESHOLE_TIME/MSG_THRESHOLE_AMOUNT;

    const twitchMsgsObserver = new Rx.Subject();
    twitchMsgsObserver.concatMap(s => Rx.Observable.from([s]).delay(messageTime)).subscribe(toSay => twitchClient.say(toSay.channel, toSay.message));

    twitchClient.on('chat', (channel, userstate, message, self) => {
        // console.log(`[TwitchJS]: Message "${message}" received from ${userstate['display-name']}`);

        if (self) return;

        if (message === '!stats') {
            // twitchClient.whisper(userstate.username, `Here will be your stats ${userstate['display-name']}`);
        }
        if (message === '!hello') {
            // twitchClient.whisper(userstate.username, `Hello ${userstate['display-name']}!`);
        }
        if (message === '!eternals') {
            getPlayerEternals(userstate.username)
            .then(eternals => twitchClient.say(channel, `User ${userstate['display-name']} has ${eternals} eternal pixel(s)`))
            .catch(err => {});
        }
        if (dotCommandRegEx.test(message)) {
            const messageData = message.match(dotCommandRegEx);
            if (validateMessageData(messageData)) {
                const dot = getDotFromMessage(messageData, userstate.username, true);
                const action = {
                    message: "CHANGE_PIXEL",
                    data: {
                        pixel: dot,
                    }
                }
                const resultPromise = gameStateModifier(action);
                resultPromise.then(result => {
                    if (result === PIXEL_CHANGED) {
                        // twitchClient.whisper(userstate.username ,`You changed the pixel (${dot.x}, ${dot.y}) to ${messageData[3]}!!`);
                        twitchMsgsObserver.next({channel: channel, message: `${ userstate['display-name'] } changed the pixel (${dot.x}, ${dot.y}) to ${messageData[3]}!!`});
                    } else if (result === PIXEL_IS_ETERNAL) {
                        // twitchClient.whisper(userstate.username, `The pixel (${dot.x},${dot.y}) cannot be changed, it was eternally set by user ${gameState.grid[dot.x][dot.y].lastPlayer}!`)
                    } else if (result === USER_COOLDOWN) {
                        // twitchClient.whisper(userstate.username, `You have to wait ${Math.floor(timeToCoolPlayer(dot.lastPlayer)/1000)} seconds to place a pixel, ${dot.lastPlayer}!`);
                    }
                })
                
            }
            else {
                // twitchClient.whisper(userstate.username, "Invalid command! Please check and try again!");
            }
        }
        else if (message.startsWith("!pixel")) {
            // twitchClient.whisper(userstate.username, "Invalid command! Please check and try again!");
        }
        if (eternalCommandRegEx.test(message)) {
            const messageData = message.match(eternalCommandRegEx);
            if(validateMessageData(messageData)) {
                const dot = getDotFromMessage(messageData, userstate.username, false);
                const action = {
                    message: "CHANGE_PIXEL",
                    data: {
                        pixel: dot,
                    }
                }
                const resultPromise = gameStateModifier(action);
                resultPromise.then(result => {
                    if (result === PIXEL_CHANGED) {
                        twitchClient.say(channel,`${userstate['display-name']} set pixel (${dot.x}, ${dot.y}) to ${messageData[3]} ETERNALLY!!`);
                        // console.log("ETERNAL PIXEL SET!");
                        // twitchClient.say(channel, `ETERNALLLLL POWWWAAAA!`);
                    } else if (result === PIXEL_IS_ETERNAL) {
                        twitchClient.say(channel, `The pixel (${dot.x},${dot.y}) cannot be changed, it was eternally set by user ${gameState.grid[dot.x][dot.y].lastPlayer}!`)
                    }
                })
            }
            else {
                // twitchClient.whisper(userstate.username, "Invalid command! Please check and try again!");
            }
        }
        else if (message.startsWith("!eternal")) {
            // twitchClient.whisper(userstate.username, "Invalid command! Please check and try again!");
        }
    })

    twitchClient.connect();

    app.use(express.static('public'));
    app.get('/', (req, res) => {
        res.sendFile(`${__dirname}/public/index.html`);
    })

    io.on('connection', (socket) => {
        // console.log('[Socket.io]: Client connected.');
        socket.on('disconnect', () => {
            // console.log('[Socket.io]: Client disconnected!');
        })
        socket.on('getGridData', () => {
            // console.log("[Socket.io]: Sending grid data.");
            // console.log(gameState.grid);
            socket.emit('gridData', { grid: gameState.grid })
        })
    })

    // Streamtips thing:
    const access_token = "ODYxZmZmN2U0YjMxZjA0MTdlYzJlMmFl";
    const tipSocket = new WebSocket('wss://streamtip.com/ws?access_token=' + encodeURIComponent(access_token) + '&client_id=5943f4fadbf7711798c6d0bf');

    tipSocket.onmessage = function(message) {
        const event = JSON.parse(message.data);

        if(event.name === 'newTip') {
            // We got a new tip!
            const data = event.data;
            const tip = { 
                channel: data.channel,
                processor: data.processor,
                transactionId: data.transactionId,
                currencyCode: data.currencyCode,
                currencySymbol: data.currencySymbol, 
                cents: data.cents,
                StreamTipObjectId: data._id,
                note: data.note,
                email: data.email,
                username: data.username.toLowerCase(),
                lastName: data.lastName,
                firstName: data.firstName,
                pending: data.pending,
                reversed: data.reversed,
                deleted: data.deleted,
                date: data.date,
                amount: data.amount 
            }
            // insert new tip
            tipsCollection.insertOne(tip);
            // Give eternals to user
            if  (tip.amount && tip.currencyCode == 'USD' && tip.amount >= 100) {
                const eternalsAmount = Math.floor(tip.amount/100);
                eternalsCollection.updateOne(
                    { username: tip.username },
                    { $inc: {eternals: eternalsAmount}},
                    { upsert: true },
                )
            }
            console.log(event.data);
            // send message note
            if (tip.note && tip.amount && tip.currencyCode == 'USD' && tip.amount >= 10) {
                io.emit("tipMessage", {
                    username: tip.username,
                    message: tip.note,
                    currencyCode: tip.currencyCode,
                    amount: tip.amount,
                })
            }
        }
    };

    tipSocket.onclose = function(err) {
        if(err.code === 4010) {
            console.log('[tipSocket]: Authentication Failed');
        } else if(err.code === 4290) {
            console.log('[tipSocket]: Rate Limited');
        } else if(err.code === 4000) {
            console.log('[tipSocket]: Bad Request');
        }
    };


    http.listen(3000, () => {
        console.log('[Express]: Listening at port 3000.');
    });
});

function populateGridFromDB(gridData) {
    gridData.forEach(element => {
        gameState.grid[`${element.x},${element.y}`] = {
            x: element.x,
            y: element.y,
            color: element.color,
            canChange: element.canChange,
            lastPlayer: element.lastPlayer
        }
    })
}
