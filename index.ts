
import * as google from 'googleapis';
import * as googleAuth from 'google-auth-library';
import * as fs from 'fs/promises';
import * as readline from 'readline';
import * as timers from 'timers/promises';

const SCOPES = ['https://www.googleapis.com/auth/youtube.force-ssl'];
const TOKEN_FILENAME = 'token.json';
const AUTH_FILENAME = 'auth.json';
const DATA_FILENAME = 'data.json';
const LEDGER_FILENAME = 'ledger.txt';

const REQUIRED_LANGUAGES = ['en', 'ko'];
const DAILY_QUOTA = 10000;
const VIDEOS_PER_SEARCH = 50;
const SEARCH_COST = 100;
const CAPTIONS_COST = 50;
const COST_PER_ROUND = SEARCH_COST + VIDEOS_PER_SEARCH * CAPTIONS_COST;

const WORK_HOUR = 3;

/* util */

type AuthData = {
	client_id: string,
	client_secret: string,
	redirect_uris: string[],
};

type SavedVideo = {
	id: string,
	title: string,
	channelId: string,
	channelTitle: string,
};

type Data = {
	day: Day | undefined,
	pageToken: string | undefined,
};

class Day {
	year: number;
	month: number;
	day: number;

	constructor(year: number, month: number, day: number) {
		this.year = year;
		this.month = month;
		this.day = day;
	}

	differs = (other: Day) => other.year !== this.year || other.month !== this.month || other.day !== this.day;
	toDate = () => new Date(this.year, this.month, this.day);
	nextDay = () => {
		const date = this.toDate();
		date.setDate(date.getDate() + 1);
		return Day.fromDate(date);
	}

	static fromDate = (date: Date) => new Day(date.getFullYear(), date.getMonth(), date.getDate());
	static fromString = (dateString: string) => Day.fromDate(new Date(dateString));
	static now = () => Day.fromDate(new Date());
};

const funErr = (message: string) => { throw message; };

const asyncFilter = async <T>(array: T[], condition: (_: T) => Promise<boolean>) => {
	const passes = (await Promise.all(array.map(element => condition(element))));
	return array.filter((_, i) => passes[i]);
}

/* google api authorization */

const makeAuthData = (authFile: any): AuthData | undefined => {
	const { client_id, client_secret, redirect_uris } = authFile.installed;

	return typeof client_id === 'string' &&
	typeof client_secret === 'string' &&
	Array.isArray(redirect_uris) ? { client_id, client_secret, redirect_uris } : undefined;
};

const makeData = (dataFile: any): Data | undefined => {
	const { day, pageToken } = dataFile;
	const { year, month, day: day2 } = day !== undefined ? day : { year: undefined, month: undefined, day: undefined };

	return typeof year === 'number' &&
	typeof month === 'number' &&
	typeof day2 === 'number' &&
	(pageToken === undefined || typeof pageToken === 'string') ?
	{ day: new Day(year, month, day2), pageToken } :
	undefined;
}

const loadToken = async (filename: string) => {
	try {
		return JSON.parse((await fs.readFile(filename)).toString()) as google.Auth.Credentials;
	} catch {
		return undefined;
	}
};

const saveToken = (filename: string, token: google.Auth.Credentials) => 
	fs.writeFile(filename, JSON.stringify(token));

const loadClient = (filename: string) => fs.readFile(filename).then(async buffer => {
	const authFile = JSON.parse(buffer.toString());
	const { client_id, client_secret, redirect_uris } = makeAuthData(authFile) ?? funErr('not an auth file');

	const client = new googleAuth.OAuth2Client({
		clientId: client_id,
		clientSecret: client_secret,
		redirectUri: redirect_uris[0] ?? 'http://localhost'
	});

	const token = await loadToken(TOKEN_FILENAME) ?? await getNewToken(client);
	client.setCredentials(token);

	return client;
});

const getNewToken = (client: googleAuth.OAuth2Client) => new Promise<google.Auth.Credentials>(accept => {
	const authUrl = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });

	console.log('authorize with this url: ', authUrl);
	
	const line = readline.createInterface({
		input: process.stdin, output: process.stdout
	});

	line.question('Enter code from the page: ', code => {
		line.close();

		client.getToken(code, (err, token) => {
			if (err) throw `token error: ${err}`;
			if (token === null || token === undefined) throw 'token missing';

			saveToken(TOKEN_FILENAME, token);
			accept(token);
		});
	});
});

/* youtube api calls */

const isSavedVideo = (object: any): object is SavedVideo => {
	return object.id && object.title && object.channelId && object.channelTitle
}

const youtubeSearch = (
	client: googleAuth.OAuth2Client,
	pageToken: string | undefined
): Promise<[string | undefined, SavedVideo[]]> =>
	google.google.youtube('v3').search.list({
		auth: client,
		part: ['snippet'],
		maxResults: VIDEOS_PER_SEARCH,
		pageToken: pageToken,
		q: '-music -sports',
		relevanceLanguage: 'ko',
		type: ['video'],
		videoCaption: 'closedCaption'
	}, {
		responseType: 'json'
	}).then(response => [
		response.data.nextPageToken ?? undefined,
		response.data.items?.map(item => ({
			id: item.id?.videoId,
			title: item.snippet?.title,
			channelId: item.snippet?.channelId,
			channelTitle: item.snippet?.channelTitle,
		})).filter(isSavedVideo) ?? []
	]);

const youtubeCaptions = (client: googleAuth.OAuth2Client, videoId: string, required: string[]) =>
	google.google.youtube('v3').captions.list({
		auth: client,
		part: ['snippet'],
		videoId: videoId,
	}, {
		responseType: 'json'
	}).then(response =>
		required.every(language => (response.data.items ?? []).some(item => item.snippet?.language === language && item.snippet?.trackKind !== 'ASR'))
	);

/* storage */
const defaultData = (): Data => ({
	day: undefined,
	pageToken: undefined,
});

const loadData = (filename: string) =>
	fs.readFile(filename).then(buffer => makeData(JSON.parse(buffer.toString()))).catch(() => undefined);

const saveData = (filename: string, data: Data) => fs.writeFile(filename, JSON.stringify(data));

const writeToLedger = (filename: string, data: string[]) =>
	fs.writeFile(filename, data.join(' ') + ' ', { flag: 'a' });

const findGoodVideos = async (client: googleAuth.OAuth2Client, pageToken: string | undefined, required: string[]): Promise<[string | undefined, SavedVideo[]]> => {
	const [nextPageToken, savedVideos] = await youtubeSearch(client, pageToken);
	const goodVideos = await asyncFilter(savedVideos, video => youtubeCaptions(client, video.id, required));

	return [nextPageToken, goodVideos];
}

const findNextTime = (last: Day | undefined, current: Day) => {
	const target = (last === undefined || last.differs(current) ? current : current.nextDay()).toDate()
	target.setHours(WORK_HOUR);
	return target;
}

/* begin */

let globalData: Data;

loadClient(AUTH_FILENAME).then(async client => {
	globalData = await loadData(DATA_FILENAME) ?? defaultData();
	
	console.log('using data: ', globalData);

	while (true) {
		const nowTime = Date.now()
		const nextDate = findNextTime(globalData.day, Day.now());

		console.log(`found next work time at ${nextDate}`);

		const waitTime = nextDate.getTime() - nowTime;

		/* wait until it is time to work */
		if (waitTime > 0) {
			console.log(`waiting for ${Math.round(waitTime / 1000)} seconds...`)
			await timers.setTimeout(waitTime);
		}

		try {
			/* do as many rounds as possible for our quota for the day */
			let quota = DAILY_QUOTA;

			while (quota >= COST_PER_ROUND) {
				const [nextPageToken, goodVideos] = await findGoodVideos(client, globalData.pageToken, REQUIRED_LANGUAGES);
				await writeToLedger(LEDGER_FILENAME, goodVideos.map(video => video.id));

				console.log(
					`found ${goodVideos.length} good videos out of ${VIDEOS_PER_SEARCH} for page ${globalData.pageToken}.\n`,
					`next page: ${nextPageToken}`
				);

				globalData.pageToken = nextPageToken;
				quota -= COST_PER_ROUND;

				console.log(`remaining quota: ${quota}`);
			}
		} catch (err) {
			console.log('error encountered today, aboring: ', err);	
		}

		globalData.day = Day.now();
		await saveData(DATA_FILENAME, globalData);

		console.log('all done for the day');
	}
}).catch(err => {
	console.log('Client could not be loaded: ', err);
});
