import { useState } from "react";
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
			{(floorplan.windows ?? []).map((window) => {
				const wall = walls.find((item) => item.id === window.wall_id);
				if (!wall) return null;
				const dx = wall.end.x - wall.start.x;
				const dy = wall.end.y - wall.start.y;
				const distance = Math.hypot(dx, dy);
				if (!distance) return null;
				const fraction = Math.min(
					1,
					Math.max(0, window.position_along_m / distance),
				);
				const width = Math.max(10, window.width_m * scale);
				return (
					<Pressable
						key={window.id}
						accessibilityRole="button"
						accessibilityLabel={`Window ${window.id}`}
						onPress={() => onSelect?.(window.id)}
						style={{
							position: "absolute",
							left:
								20 + (wall.start.x + dx * fraction - minX) * scale - width / 2,
							top: 20 + (wall.start.y + dy * fraction - minY) * scale - 5,
							width,
							height: 10,
							borderTopWidth: 2,
							borderBottomWidth: 2,
							borderColor:
								selected === window.id || changed(window, compareTo?.windows)
									? "#f1a977"
									: "#83cfff",
							backgroundColor: "#20352b",
							transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }],
						}}
					/>
				);
			})}
			{(floorplan.rooms ?? []).map((room) => {
				if (!room.polygon.length && !room.label_point) return null;
				const point = room.label_point ?? [
					room.polygon.reduce((sum, p) => sum + p[0], 0) / room.polygon.length,
					room.polygon.reduce((sum, p) => sum + p[1], 0) / room.polygon.length,
				];
				return (
					<Text
						key={room.id}
						pointerEvents="none"
						style={{
							position: "absolute",
							left: 20 + (point[0] - minX) * scale - 50,
							top: 20 + (point[1] - minY) * scale - 10,
							width: 100,
							textAlign: "center",
							color: changed(room, compareTo?.rooms) ? "#f1a977" : "#edf4e9",
							fontSize: 11,
						}}
					>
						{room.name}
					</Text>
				);
			})}
			{(floorplan.dimensions ?? []).map((dimension) => (
				<Text
					key={dimension.id}
					pointerEvents="none"
					style={{
						position: "absolute",
						left:
							20 +
							((dimension.start.x + dimension.end.x) / 2 - minX) * scale -
							35,
						top:
							20 + ((dimension.start.y + dimension.end.y) / 2 - minY) * scale,
						width: 70,
						textAlign: "center",
						color: changed(dimension, compareTo?.dimensions)
							? "#f1a977"
							: "#edf4e9",
						fontSize: 10,
					}}
				>
					{dimension.label}
				</Text>
			))}
		</View>
	);
}
const sections = ["walls", "doors", "windows", "rooms", "dimensions"] as const;
function describe(value: unknown): string {
	if (Array.isArray(value)) return value.map(describe).join(", ");
	if (value && typeof value === "object")
		return Object.entries(value)
			.map(([key, item]) => `${key.replaceAll("_", " ")}: ${describe(item)}`)
			.join("; ");
	return String(value);
}
export function PlanDetails({
	floorplan,
	compareTo,
}: {
	floorplan?: Floorplan;
	compareTo?: Floorplan;
}) {
	const [expanded, setExpanded] = useState(false);
	if (!floorplan) return null;
	return (
		<View style={styles.details}>
			<Pressable
				accessibilityRole="button"
				accessibilityState={{ expanded }}
				onPress={() => setExpanded((value) => !value)}
			>
				<Text style={styles.detailHeading}>
					{expanded ? "Hide" : "Show"} {compareTo ? "proposal" : "plan"} details
				</Text>
			</Pressable>
			{expanded && (
				<>
					{sections.map((section) => (
						<View key={section}>
							<Text style={styles.detailHeading}>{section.toUpperCase()}</Text>
							{(floorplan[section] ?? []).map((item) => (
								<Text key={item.id} style={styles.detailText}>
									{describe(item)}
								</Text>
							))}
							{!(floorplan[section] ?? []).length && (
								<Text style={styles.detailText}>None</Text>
							)}
						</View>
					))}
					<Text style={styles.detailText}>
						Total area: {floorplan.total_area_m2} m²
					</Text>
					{compareTo && (
						<View>
							<Text style={styles.detailHeading}>
								Changes from accepted plan
							</Text>
							{sections.flatMap((section) => {
								const before = compareTo[section] ?? [];
								const after = floorplan[section] ?? [];
								const ids = new Set([
									...before.map((item) => item.id),
									...after.map((item) => item.id),
								]);
								return [...ids].flatMap((id) => {
									const old = before.find((item) => item.id === id);
									const next = after.find((item) => item.id === id);
									if (JSON.stringify(old) === JSON.stringify(next)) return [];
									return [
										<Text key={`${section}-${id}`} style={styles.detailText}>
											{section} {id}
											{"\n"}Before: {old ? describe(old) : "Not present"}
											{"\n"}After: {next ? describe(next) : "Removed"}
										</Text>,
									];
								});
							})}
							{floorplan.total_area_m2 !== compareTo.total_area_m2 && (
								<Text style={styles.detailText}>
									Total area: {compareTo.total_area_m2} →{" "}
									{floorplan.total_area_m2} m²
								</Text>
							)}
						</View>
					)}
				</>
			)}
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
	details: { gap: 8, marginTop: 12 },
	detailHeading: { color: "#edf4e9", fontWeight: "bold", marginTop: 6 },
	detailText: { color: "#b6c7be", marginTop: 4 },
});
