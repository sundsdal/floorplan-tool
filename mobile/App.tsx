declare const process: { env: { EXPO_PUBLIC_API_URL?: string } };

import { VideoView } from "@livekit/react-native";
import type { LocalVideoTrack } from "livekit-client";
import { useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	SafeAreaView,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from "react-native";
import { LiveGuide } from "./src/live";

export default function App() {
	const [server, setServer] = useState(
		process.env.EXPO_PUBLIC_API_URL || "http://10.0.2.2:3000",
	);
	const [recording, setRecording] = useState(false);
	const [analysisPending, setAnalysisPending] = useState(false);
	const [busy, setBusy] = useState(false);
	const [connected, setConnected] = useState(false);
	const [preview, setPreview] = useState<LocalVideoTrack>();
	const [transcript, setTranscript] = useState("");
	const [question, setQuestion] = useState("");
	const [finding, setFinding] = useState("");
	const [error, setError] = useState("");
	const [result, setResult] = useState("");
	const guide = useRef<LiveGuide | null>(null);
	useEffect(
		() => () => {
			void guide.current?.close();
		},
		[],
	);
	const start = async () => {
		setBusy(true);
		setError("");
		setResult("");
		setFinding("");
		setTranscript("");
		const client = new LiveGuide(server.replace(/\/$/, ""), {
			status: (online, message) => {
				setConnected(online);
				if (message) setError(message);
			},
			preview: setPreview,
			transcript: (text) =>
				setTranscript((old) =>
					`${old}${old ? "\n\n" : ""}${text}`.slice(-3000),
				),
			finding: setFinding,
		});
		guide.current = client;
		try {
			await client.connect();
			setRecording(true);
		} catch (e) {
			guide.current = null;
			setError(e instanceof Error ? e.message : "Could not start walkthrough.");
		} finally {
			setBusy(false);
		}
	};
	const stop = async () => {
		const client = guide.current;
		if (!client) return;
		setBusy(true);
		setRecording(false);
		setAnalysisPending(true);
		setError("");
		setResult("Preparing your floor plan…");
		try {
			const data = JSON.parse(await client.finalize()) as {
				floorplan: unknown;
			};
			setResult(
				`Floor plan ready.\n${JSON.stringify(data.floorplan, null, 2)}`,
			);
			await client.close();
			guide.current = null;
			setAnalysisPending(false);
		} catch {
			await client.close();
			setError("Recording stopped. Analysis is not ready; please retry.");
			setResult("");
		} finally {
			setBusy(false);
		}
	};
	const send = async () => {
		const text = question.trim();
		if (!text || !guide.current) return;
		try {
			await guide.current.sendText(text);
			setQuestion("");
		} catch {
			setError("Could not send your question.");
		}
	};
	return (
		<SafeAreaView style={styles.screen}>
			<ScrollView
				contentContainerStyle={styles.content}
				keyboardShouldPersistTaps="handled"
			>
				<Text style={styles.eyebrow}>FLOORPLAN / FIELD CAPTURE</Text>
				<Text style={styles.title}>Walk the space.</Text>
				<Text style={styles.subtitle}>
					Film each room and doorway. Your guide will help you find the views
					the plan needs.
				</Text>
				<View style={styles.camera}>
					{preview && (
						<VideoView videoTrack={preview} style={StyleSheet.absoluteFill} />
					)}
					<Text style={styles.cameraLabel}>
						{recording
							? "●  RECORDING"
							: analysisPending
								? "○  RECORDING STOPPED"
								: "○  CAMERA READY"}
					</Text>
				</View>
				<View style={styles.status}>
					<Text style={styles.statusText}>
						{recording ? "●  Recording walkthrough" : "○  Not recording"}
					</Text>
					<Text style={styles.statusText}>
						{connected ? "●  Guide connected" : "○  Guide offline"}
					</Text>
				</View>
				{!recording && !analysisPending && (
					<>
						<Text style={styles.small}>SERVER ADDRESS</Text>
						<TextInput
							style={styles.input}
							value={server}
							onChangeText={setServer}
							autoCapitalize="none"
							autoCorrect={false}
							editable={!busy}
						/>
					</>
				)}
				<TouchableOpacity
					accessibilityRole="button"
					disabled={busy}
					style={styles.primary}
					onPress={() => void (recording || analysisPending ? stop() : start())}
				>
					{busy ? (
						<ActivityIndicator color="#10231d" />
					) : (
						<Text style={styles.primaryText}>
							{recording
								? "Finish & generate plan"
								: analysisPending
									? "Retry analysis"
									: "Start walkthrough"}
						</Text>
					)}
				</TouchableOpacity>
				{recording && (
					<>
						<View style={styles.guide}>
							<Text style={styles.small}>LIVE GUIDE</Text>
							<Text style={styles.guideText}>
								{transcript ||
									(connected
										? "Walk slowly through the first room."
										: "Connecting the guide…")}
							</Text>
							{!!finding && <Text style={styles.finding}>{finding}</Text>}
						</View>
						<View style={styles.row}>
							<TextInput
								style={[styles.input, styles.flex]}
								value={question}
								onChangeText={setQuestion}
								placeholder="Ask the guide"
								placeholderTextColor="#7d8986"
								onSubmitEditing={() => void send()}
							/>
							<TouchableOpacity
								accessibilityRole="button"
								disabled={!connected || !question.trim()}
								style={styles.send}
								onPress={() => void send()}
							>
								<Text style={styles.primaryText}>Send</Text>
							</TouchableOpacity>
						</View>
					</>
				)}
				{!!error && <Text style={styles.error}>{error}</Text>}
				{!!result && (
					<Text selectable style={styles.result}>
						{result}
					</Text>
				)}
			</ScrollView>
		</SafeAreaView>
	);
}
const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: "#101b18" },
	content: { padding: 20, gap: 14 },
	eyebrow: {
		color: "#a8c4b7",
		fontSize: 11,
		fontWeight: "700",
		letterSpacing: 2,
	},
	title: { color: "#f4f5ed", fontSize: 36, fontWeight: "700" },
	subtitle: { color: "#b6c7be", fontSize: 16, lineHeight: 23 },
	camera: {
		height: 320,
		backgroundColor: "#263a32",
		borderRadius: 18,
		overflow: "hidden",
	},
	cameraLabel: {
		position: "absolute",
		top: 16,
		left: 16,
		color: "white",
		backgroundColor: "#14231d",
		padding: 8,
		borderRadius: 12,
	},
	status: { flexDirection: "row", justifyContent: "space-between" },
	statusText: { color: "#adbeb5", fontSize: 12 },
	small: {
		color: "#a8c4b7",
		fontSize: 11,
		fontWeight: "700",
		letterSpacing: 1,
	},
	input: {
		color: "#f4f5ed",
		backgroundColor: "#263a32",
		borderRadius: 12,
		padding: 14,
		fontSize: 15,
	},
	primary: {
		backgroundColor: "#b9edc9",
		padding: 17,
		borderRadius: 12,
		alignItems: "center",
	},
	primaryText: { color: "#10231d", fontWeight: "700", fontSize: 16 },
	guide: { backgroundColor: "#20352b", padding: 16, borderRadius: 14, gap: 10 },
	guideText: { color: "#f4f5ed", fontSize: 16, lineHeight: 23 },
	finding: { color: "#b9edc9", lineHeight: 22 },
	row: { flexDirection: "row", gap: 8 },
	flex: { flex: 1 },
	send: {
		justifyContent: "center",
		paddingHorizontal: 18,
		backgroundColor: "#b9edc9",
		borderRadius: 12,
	},
	error: { color: "#ffa99d", lineHeight: 20 },
	result: { color: "#e0eee4", fontSize: 12 },
});
