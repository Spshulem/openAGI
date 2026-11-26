// OpenAGI Pocket / compact form study 05
// Millimetres. Visual envelope only: not a ready-to-print electrical enclosure.
// Change explode to 1 to inspect the two halves and component envelope proxies.
$fn = 64;
explode = 0;
outer_w = 58;
outer_h = 55;
outer_d = 23;
corner_r = 8;
wall_target = 1.8;

default_gap = 18;
gap = explode ? default_gap : 0;

module rounded_rect(w,h,r) {
  offset(r=r) square([w-2*r,h-2*r],center=true);
}
module slab(w,h,d,r) {
  linear_extrude(height=d,center=true) rounded_rect(w,h,r);
}
module front() {
  color([.76,.72,.63]) translate([0,0,-5.75-gap]) slab(outer_w,outer_h,11.5,corner_r);
  color([.478,.235,1.0]) translate([0,0,-11.75-gap]) slab(47,44,.5,6);
  color([.11,.12,.11]) translate([0,0,-12.1-gap]) slab(46,43,.35,5.7);
  // The 26.86 mm active panel is smaller than the dark cosmetic window.
  color([.02,.025,.023]) translate([0,0,-12.4-gap]) slab(26.86,26.86,.2,.6);
  color([.72,.60,1.0]) translate([-20,20,-11.75-gap]) slab(3.5,.8,.45,.4);
  color([.478,.235,1.0]) translate([29.2,-5,0]) cube([1.6,12,8],center=true);
}
module back() {
  color([.76,.72,.63]) translate([0,0,5.75+gap]) slab(outer_w,outer_h,11.5,corner_r);
  color([.72,.69,.61]) translate([0,0,11.7+gap]) slab(48,45,.45,6);
  for (x=[-20,20], y=[-18,18])
    color([.18,.17,.15]) translate([x,y,12.15+gap]) cylinder(h=.35,r=1.7,center=true);
  for (x=[-10:4:10])
    color([.14,.14,.13]) translate([x,-3,12.17+gap]) slab(1,10,.25,.4);
}
module envelopes() {
  if (explode) {
    color([.15,.17,.16]) translate([0,0,0]) slab(44.5,37,1.4,1);  // selected OLED breakout XY
    color([.11,.30,.24]) translate([-11,-13,2]) slab(17.8,21,1.5,1);  // XIAO ESP32-S3 Plus proxy
    color([.50,.50,.47]) translate([0,10,4]) slab(30,20,6,2);       // battery placeholder only
  }
}
front(); back(); envelopes();
