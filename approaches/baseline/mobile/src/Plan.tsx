import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Scene } from "./live";

type Floorplan = Scene["floorplan"];
export function Plan({
	floorplan,
	selected,
	onSelect,
	compareTo,
}: {
	floorplan: Floorplan;
	selected?: string;
	onSelect?: (id: string) => void;
	compareTo?: Floorplan;
}) {
	const walls = floorplan?.walls ?? [];
	const changed = (item: { id: string }, prior: { id: string }[] | undefined) =>
		compareTo &&
		JSON.stringify(item) !==
			JSON.stringify(prior?.find((old) => old.id === item.id));
	if (!walls.length)
		return (
			<Text style={styles.empty}>
				The plan will appear as the walkthrough is reviewed.
			</Text>
		);
	const points = walls.flatMap((wall) => [wall.start, wall.end]);
	const minX = Math.min(...points.map((point) => point.x));
	const minY = Math.min(...points.map((point) => point.y));
	const spanX = Math.max(1, ...points.map((point) => point.x - minX));
	const spanY = Math.max(1, ...points.map((point) => point.y - minY));
	const scale = Math.min(260 / spanX, 200 / spanY);
	return (
		<View style={styles.canvas} accessibilityLabel="Floor plan">
			{walls.map((wall) => {
				const x = 20 + (wall.start.x - minX) * scale;
				const y = 20 + (wall.start.y - minY) * scale;
				const dx = (wall.end.x - wall.start.x) * scale;
				const dy = (wall.end.y - wall.start.y) * scale;
				const length = Math.hypot(dx, dy);
				return (
					<Pressable
						key={wall.id}
						accessibilityRole="button"
						accessibilityLabel={`Wall ${wall.id}`}
						onPress={() => onSelect?.(wall.id)}
						style={{
							position: "absolute",
							left: x + dx / 2 - length / 2,
							top: y + dy / 2 - 15,
							width: length,
							height: 30,
							justifyContent: "center",
							transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }],
						}}
					>
						<View
							style={{
								height: selected === wall.id ? 6 : 4,
								backgroundColor:
									selected === wall.id || changed(wall, compareTo?.walls)
										? "#f1a977"
										: "#edf4e9",
								borderRadius: 3,
							}}
						/>
					</Pressable>
				);
			})}
			{(floorplan.doors ?? []).map((door) => {
				const wall = walls.find((item) => item.id === door.wall_id);
				if (!wall) return null;
				const dx = wall.end.x - wall.start.x;
				const dy = wall.end.y - wall.start.y;
				const distance = Math.hypot(dx, dy);
				if (!distance) return null;
				const fraction = Math.min(
					1,
					Math.max(0, door.position_along_m / distance),
				);
				return (
					<Pressable
						key={door.id}
						accessibilityRole="button"
						accessibilityLabel={`Door ${door.id}`}
						onPress={() => onSelect?.(door.id)}
						style={{
							position: "absolute",
							left: 20 + (wall.start.x + dx * fraction - minX) * scale - 10,
							top: 20 + (wall.start.y + dy * fraction - minY) * scale - 10,
							width: 20,
							height: 20,
							borderRadius: 10,
							backgroundColor:
								selected === door.id || changed(door, compareTo?.doors)
									? "#f1a977"
									: "#b9edc9",
							borderWidth: 3,
							borderColor: "#20352b",
						}}
					/>
				);
			})}
		</View>
	);
}
const styles = StyleSheet.create({
	canvas: {
		height: 240,
		backgroundColor: "#20352b",
		borderRadius: 14,
		overflow: "hidden",
	},
	empty: { color: "#b6c7be", padding: 16 },
});
